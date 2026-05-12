'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  currentMailbox:    'INBOX',
  attachments:       [],   // { type:'payload'|'upload', ... }
  syncIntervalHours: 6,
  currentPayloadFile: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(n) {
  if (n < 1024)     return `${n} B`;
  if (n < 1048576)  return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function setResult(msg, isErr) {
  const el = document.getElementById('compose-result');
  el.textContent = msg;
  el.className   = isErr ? 'err' : 'ok';
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(method, path, body = null, isForm = false) {
  const opts = { method };
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

// ── Status bar ────────────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const s = await apiFetch('GET', '/api/status');
    const badge = document.getElementById('auth-badge');
    const link  = document.getElementById('auth-link');

    if (s.authenticated) {
      badge.textContent = 'Connected';
      badge.className   = 'badge badge-ok';
      link.style.display = 'none';
    } else {
      badge.textContent = 'Not connected';
      badge.className   = 'badge badge-err';
      link.style.display = '';
    }

    if (s.last_synced_at) {
      document.getElementById('sync-status').textContent =
        `Last sync: ${fmtDate(s.last_synced_at)}`;

      // Auto-sync if interval exceeded
      const hours = (Date.now() - new Date(s.last_synced_at)) / 3_600_000;
      if (hours >= state.syncIntervalHours) triggerSync(true);
    }
  } catch (e) {
    console.error('status error', e);
  }
}

// ── Compose — templates & payload ─────────────────────────────────────────────

async function loadTemplateList() {
  const templates = await apiFetch('GET', '/api/templates');
  const sel = document.getElementById('template-select');
  sel.innerHTML = '<option value="">— select a template —</option>';
  templates.forEach(t => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = t;
    sel.appendChild(opt);
  });
}

async function onTemplateChange(templateId) {
  if (!templateId) return;
  try {
    const result  = await apiFetch('GET', `/api/payloads/${templateId}`);
    const payload = result.payload || {};
    state.currentPayloadFile = result.file || null;

    document.getElementById('payload-raw').value = JSON.stringify(payload, null, 2);

    // Reset payload attachments, keep user uploads
    state.attachments = state.attachments.filter(a => a.type === 'upload');
    if (Array.isArray(payload.attachments)) {
      payload.attachments.forEach(da => {
        state.attachments.unshift({
          type: 'payload', path: da.path,
          filename: da.filename || da.path, metadataText: '{}',
        });
      });
    }
    renderAttachments();
    await doPreview();
  } catch (e) {
    console.error('payload load error', e);
  }
}

// ── Compose — preview ─────────────────────────────────────────────────────────

async function doPreview() {
  const templateId = document.getElementById('template-select').value;
  if (!templateId) return;

  let payload;
  try { payload = JSON.parse(document.getElementById('payload-raw').value || '{}'); }
  catch { setResult('Invalid JSON in payload', true); return; }

  const toAddress = (payload.to || '').trim();
  const subject   = (payload.subject || '').trim();
  const data      = payload.data || {};

  document.getElementById('preview-to').textContent = toAddress ? `To: ${toAddress}` : '';

  try {
    const r = await apiFetch('POST', '/api/preview', { template_id: templateId, data, to_address: toAddress, subject });
    document.getElementById('preview-subject').textContent =
      r.subject ? `Subject: ${r.subject}` : '';
    document.getElementById('preview-frame').srcdoc = r.html;
  } catch (e) {
    setResult(`Preview error: ${e.message}`, true);
  }
}

// ── Compose — attachments ─────────────────────────────────────────────────────

function addFiles(files) {
  for (const file of files) {
    state.attachments.push({ type: 'upload', file, metadataText: '{}' });
  }
  renderAttachments();
}

function removeAttachment(idx) {
  state.attachments.splice(idx, 1);
  renderAttachments();
}

const PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp|svg)$/i;

function canPreview(filename) {
  return PREVIEWABLE.test(filename);
}

function previewAttachment(idx) {
  const att = state.attachments[idx];
  if (att.type === 'upload') {
    const url = URL.createObjectURL(att.file);
    window.open(url, '_blank');
  } else {
    window.open(`/api/file?path=${encodeURIComponent(att.path)}`, '_blank');
  }
}

function renderAttachments() {
  const list = document.getElementById('attachment-list');
  list.innerHTML = '';
  state.attachments.forEach((att, i) => {
    const isUpload  = att.type === 'upload';
    const name      = isUpload ? att.file.name : att.filename;
    const meta      = isUpload ? `<span class="att-size">${fmtBytes(att.file.size)}</span>` : '';
    const previewBtn = canPreview(name)
      ? `<button class="btn btn-sm btn-outline" data-preview="${i}">Aperçu</button>`
      : '';

    const li = document.createElement('li');
    li.className = 'att-item';
    li.innerHTML = `
      <div class="att-header">
        <span class="att-name" title="${esc(name)}">${esc(name)}</span>
        <span style="display:flex;align-items:center;gap:6px">
          ${meta}
          ${previewBtn}
          <button class="btn btn-sm" data-rm="${i}">✕</button>
        </span>
      </div>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('[data-rm]').forEach(btn =>
    btn.addEventListener('click', () => removeAttachment(+btn.dataset.rm))
  );
  list.querySelectorAll('[data-preview]').forEach(btn =>
    btn.addEventListener('click', () => previewAttachment(+btn.dataset.preview))
  );
}

// ── Compose — send / draft ────────────────────────────────────────────────────

async function composeSend(isDraft) {
  const templateId = document.getElementById('template-select').value;
  if (!templateId) { setResult('Select a template first.', true); return; }

  let payload;
  try { payload = JSON.parse(document.getElementById('payload-raw').value || '{}'); }
  catch { setResult('Invalid JSON in payload', true); return; }

  const toAddress   = (payload.to || '').trim();
  const subject     = (payload.subject || '').trim();
  const templateData = payload.data || {};
  const ccRaw       = payload.cc;
  const ccList      = Array.isArray(ccRaw)
    ? ccRaw
    : (ccRaw ? String(ccRaw).split(',').map(s => s.trim()).filter(Boolean) : []);

  if (!isDraft && !toAddress) { setResult('Recipient (To) is required in the payload.', true); return; }

  let businessMeta = document.getElementById('business-metadata').value.trim() || '{}';
  try { JSON.parse(businessMeta); } catch {
    setResult('Invalid JSON in business metadata.', true); return;
  }

  const fd = new FormData();
  fd.append('template_id',       templateId);
  fd.append('to_address',        toAddress);
  fd.append('cc_addresses',      JSON.stringify(ccList));
  fd.append('subject',           subject);
  fd.append('template_data',     JSON.stringify(templateData));
  fd.append('business_metadata', businessMeta);
  fd.append('is_draft',          isDraft ? '1' : '0');

  const payloadAtts = [];
  let uploadIdx = 0;
  state.attachments.forEach((att) => {
    if (att.type === 'payload') {
      payloadAtts.push({ path: att.path, filename: att.filename });
    } else {
      fd.append(`file_${uploadIdx}`,          att.file, att.file.name);
      fd.append(`metadata_file_${uploadIdx}`, att.metadataText);
      uploadIdx++;
    }
  });
  fd.append('default_attachments', JSON.stringify(payloadAtts));
  if (state.currentPayloadFile) fd.append('payload_file', state.currentPayloadFile);

  const btnSend  = document.getElementById('btn-send');
  const btnDraft = document.getElementById('btn-draft');
  btnSend.disabled = btnDraft.disabled = true;
  setResult(isDraft ? 'Saving…' : 'Sending…', false);

  try {
    const r = await apiFetch('POST', '/api/compose/send', fd, true);
    setResult(
      isDraft ? `Draft saved (id=${r.id})` : `Sent successfully (id=${r.id})`,
      false
    );
    if (!isDraft) {
      document.getElementById('template-select').value   = '';
      document.getElementById('payload-raw').value       = '';
      document.getElementById('business-metadata').value = '';
      document.getElementById('preview-to').textContent  = '';
      state.attachments        = [];
      state.currentPayloadFile = null;
      renderAttachments();
    }
  } catch (e) {
    setResult(e.message, true);
  } finally {
    btnSend.disabled = btnDraft.disabled = false;
  }
}

// ── Mail — messages ───────────────────────────────────────────────────────────

async function loadMessages() {
  const params = new URLSearchParams({ mailbox: state.currentMailbox });
  const dateFrom  = document.getElementById('filter-date-from').value;
  const dateTo    = document.getElementById('filter-date-to').value;
  const recipient = document.getElementById('filter-recipient').value.trim();
  const label     = document.getElementById('filter-label').value.trim();

  if (dateFrom)  params.set('date_from', dateFrom);
  if (dateTo)    params.set('date_to',   dateTo);
  if (recipient) params.set('recipient', recipient);
  if (label)     params.set('label',     label);

  try {
    const msgs = await apiFetch('GET', `/api/gmail/messages?${params}`);
    renderMessages(msgs);
  } catch (e) {
    console.error('loadMessages error', e);
  }
}

function renderMessages(msgs) {
  const tbody = document.getElementById('mail-tbody');
  const empty = document.getElementById('mail-empty');
  tbody.innerHTML = '';

  if (!msgs.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const isSent = state.currentMailbox === 'SENT';

  msgs.forEach(m => {
    const addr = isSent
      ? (m.to_address   || '—')
      : (m.from_address || '—');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${esc(addr)}">${esc(addr)}</td>
      <td title="${esc(m.subject)}">${esc(m.subject || '(no subject)')}</td>
      <td class="col-att">${m.has_attachment ? '📎' : ''}</td>
      <td class="col-date">${fmtDate(m.date)}</td>
      <td class="col-snippet">${esc(m.snippet || '')}</td>
    `;
    tr.addEventListener('click', () => openMailTray(m));
    tbody.appendChild(tr);
  });
}

function decodeEntities(str) {
  const el = document.createElement('textarea');
  el.innerHTML = str;
  return el.value;
}

function linkify(text) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) => {
    if (i % 2 === 1) {
      const safe = esc(part);
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    }
    return esc(part);
  }).join('');
}

async function openMailTray(msg) {
  document.getElementById('tray-subject').textContent = msg.subject || '(no subject)';

  const rows = [
    ['De',    msg.from_address],
    ['À',     msg.to_address],
    msg.cc_address ? ['Cc', msg.cc_address] : null,
    ['Date',  fmtDate(msg.date)],
    msg.labels ? ['Labels', msg.labels] : null,
  ].filter(Boolean);

  document.getElementById('tray-meta').innerHTML = rows
    .map(([k, v]) => `<div class="tray-meta-row"><strong>${k} :</strong> ${esc(v || '—')}</div>`)
    .join('');

  const snippetEl = document.getElementById('tray-snippet');
  const loaderEl  = document.getElementById('tray-loader');
  const frameEl   = document.getElementById('tray-body-frame');

  snippetEl.style.display = 'none';
  loaderEl.style.display  = '';
  frameEl.style.display   = 'none';
  frameEl.srcdoc          = '';

  const attsEl     = document.getElementById('tray-attachments');
  const classifyEl = document.getElementById('tray-classify');
  attsEl.innerHTML     = '';
  classifyEl.innerHTML = '';

  document.getElementById('mail-tray').classList.remove('mail-tray--closed');

  if (msg.gmail_message_id) {
    try {
      const data = await apiFetch('GET', `/api/gmail/message/${msg.gmail_message_id}`);
      loaderEl.style.display = 'none';

      if (data.html_body) {
        frameEl.srcdoc        = data.html_body;
        frameEl.style.display = '';
      } else {
        snippetEl.textContent   = data.text_body || msg.snippet || '';
        snippetEl.style.display = '';
      }

      const atts = data.attachments || [];
      if (atts.length) {
        attsEl.innerHTML = `
          <div class="tray-atts-label">Pièces jointes (${atts.length})</div>
          <ul class="tray-atts-list">
            ${atts.map(a => `<li><span>${esc(a.name)}</span><span class="hint">${fmtBytes(a.size)}</span></li>`).join('')}
          </ul>`;
        classifyEl.innerHTML = `<div class="classify-btn-row">
          <button class="btn btn-sm btn-outline" id="btn-classer">Classer les pièces jointes</button>
        </div>`;
        document.getElementById('btn-classer')
          .addEventListener('click', () => classifyAttachments(msg));
      }
    } catch {
      loaderEl.style.display  = 'none';
      snippetEl.textContent   = msg.snippet || '';
      snippetEl.style.display = '';
    }
  } else {
    loaderEl.style.display  = 'none';
    snippetEl.textContent   = msg.snippet || '';
    snippetEl.style.display = '';
  }
}

function closeMailTray() {
  document.getElementById('mail-tray').classList.add('mail-tray--closed');
}

async function triggerSync(silent = false, reset = false) {
  const btn      = document.getElementById('btn-sync');
  const btnReset = document.getElementById('btn-sync-reset');
  btn.disabled = btnReset.disabled = true;
  if (!silent) {
    btn.innerHTML = '<span class="btn-spinner"></span>Syncing…';
    if (reset) btnReset.innerHTML = '<span class="btn-spinner"></span>';
  }

  try {
    const url = reset ? '/api/gmail/sync?reset=1' : '/api/gmail/sync';
    const r   = await apiFetch('POST', url);
    document.getElementById('sync-status').textContent = reset
      ? `Reconciled — +${r.synced} added, ${r.removed} removed`
      : `Synced ${r.synced} new messages`;
    await refreshStatus();
    await loadMessages();
  } catch (e) {
    if (e.data?.auth_expired) {
      document.getElementById('auth-expired-modal').style.display = 'flex';
    } else if (!silent) {
      document.getElementById('sync-status').textContent = `Sync error: ${e.message}`;
    }
  } finally {
    btn.disabled = btnReset.disabled = false;
    btn.innerHTML     = 'Sync Gmail';
    btnReset.innerHTML = '↺ Reconcile';
  }
}

// ── History ───────────────────────────────────────────────────────────────────

const histState = { orderBy: 'created_at', direction: 'DESC' };

async function loadHistory() {
  const params = new URLSearchParams({
    order_by:  histState.orderBy,
    direction: histState.direction,
  });
  const dateFrom = document.getElementById('hist-date-from').value;
  const dateTo   = document.getElementById('hist-date-to').value;
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo)   params.set('date_to',   dateTo);

  try {
    const rows = await apiFetch('GET', `/api/composed?${params}`);
    renderHistory(rows);
  } catch (e) {
    console.error('history error', e);
  }
}

function renderHistory(rows) {
  const tbody = document.getElementById('hist-tbody');
  const empty = document.getElementById('hist-empty');
  const count = document.getElementById('hist-count');
  tbody.innerHTML = '';

  count.textContent = rows.length ? `${rows.length} entrée${rows.length > 1 ? 's' : ''}` : '';

  if (!rows.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${esc(r.template_id || '')}</td>
      <td title="${esc(r.to_address)}">${esc(r.to_address || '')}</td>
      <td title="${esc(r.subject)}">${esc(r.subject || '')}</td>
      <td>${statusBadge(r.status, r.is_draft)}</td>
      <td class="col-date">${fmtDate(r.created_at)}</td>
      <td class="col-date">${r.sent_at ? fmtDate(r.sent_at) : '—'}</td>
    `;
    tr.addEventListener('click', () => openPayloadModal(r));
    tbody.appendChild(tr);
  });

  // Update sort indicators
  document.querySelectorAll('#hist-table th.sortable').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === histState.orderBy);
    th.dataset.dir = col === histState.orderBy ? histState.direction : '';
  });
}

function statusBadge(status, isDraft) {
  if (isDraft) return '<span class="status-badge status-draft">brouillon</span>';
  const map = {
    sent:    '<span class="status-badge status-sent">envoyé</span>',
    failed:  '<span class="status-badge status-failed">échec</span>',
    pending: '<span class="status-badge status-pending">en attente</span>',
  };
  return map[status] || `<span class="status-badge">${esc(status)}</span>`;
}

function openPayloadModal(row) {
  const modal = document.getElementById('payload-modal');
  document.getElementById('modal-title').textContent =
    `#${row.id} — ${row.template_id || ''} → ${row.to_address || ''}`;

  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch {}

  const view = document.getElementById('payload-view');
  if (payload) {
    view.innerHTML = renderPayloadView(payload, row);
  } else {
    view.innerHTML = `<pre class="json-block">${esc(JSON.stringify({
      template_data:     tryParse(row.template_data),
      business_metadata: tryParse(row.business_metadata),
    }, null, 2))}</pre>`;
  }
  modal.style.display = 'flex';
}

function renderPayloadView(payload, row) {
  const data  = payload.data  || {};
  const atts  = payload.attachments || [];
  const biz   = tryParse(row.business_metadata) || {};

  const dataRows = Object.entries(data).map(([k, v]) =>
    `<tr><td class="pv-key">${esc(k)}</td><td>${esc(String(v))}</td></tr>`
  ).join('');

  const attList = atts.length
    ? atts.map(a => `<li>${esc(a.filename || a.path)}</li>`).join('')
    : '<li class="hint">aucune</li>';

  const bizRows = Object.entries(biz).length
    ? Object.entries(biz).map(([k, v]) =>
        `<tr><td class="pv-key">${esc(k)}</td><td>${esc(String(v))}</td></tr>`
      ).join('')
    : '<tr><td colspan="2" class="hint">—</td></tr>';

  return `
    <div class="pv-section">
      <div class="pv-label">Envoi</div>
      <table class="pv-table">
        <tr><td class="pv-key">Template</td><td>${esc(payload.template_id || '')}</td></tr>
        <tr><td class="pv-key">À</td><td>${esc(payload.to || '')}</td></tr>
        <tr><td class="pv-key">Sujet</td><td>${esc(payload.subject || row.subject || '')}</td></tr>
        <tr><td class="pv-key">Statut</td><td>${statusBadge(row.status, row.is_draft)}</td></tr>
        ${row.error_message ? `<tr><td class="pv-key">Erreur</td><td class="err">${esc(row.error_message)}</td></tr>` : ''}
      </table>
    </div>
    <div class="pv-section">
      <div class="pv-label">Données template</div>
      <table class="pv-table">${dataRows || '<tr><td colspan="2" class="hint">—</td></tr>'}</table>
    </div>
    <div class="pv-section">
      <div class="pv-label">Pièces jointes</div>
      <ul class="pv-list">${attList}</ul>
    </div>
    <div class="pv-section">
      <div class="pv-label">Metadata business</div>
      <table class="pv-table">${bizRows}</table>
    </div>
  `;
}

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

// ── Folder browser (shared) ───────────────────────────────────────────────────

let _fpData   = null;
let _fpTarget = null;  // <input> to write selected path into

async function _fpBrowseTo(path) {
  const url  = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
  const list = document.getElementById('fp-list');
  list.innerHTML = '<li class="fp-message">Chargement…</li>';
  try {
    _fpData = await apiFetch('GET', url);
    document.getElementById('fp-current').textContent = _fpData.path || 'Lecteurs disponibles';
    if (_fpData.entries.length) {
      list.innerHTML = _fpData.entries
        .map(e => `<li class="fp-item" data-path="${esc(e.path)}">${esc(e.name)}</li>`)
        .join('');
      list.querySelectorAll('.fp-item').forEach(li =>
        li.addEventListener('click', () => _fpBrowseTo(li.dataset.path))
      );
    } else {
      list.innerHTML = '<li class="fp-message">Aucun sous-dossier</li>';
    }
    const upBtn = document.getElementById('fp-up');
    upBtn.disabled = _fpData.parent === null;
    upBtn.onclick  = () => _fpBrowseTo(_fpData.parent ?? '');
  } catch (e) {
    list.innerHTML = `<li class="fp-message err">${esc(e.message)}</li>`;
  }
}

function openFolderBrowser(targetInput, startPath = '') {
  _fpTarget = targetInput;
  document.getElementById('folder-picker').style.display = '';
  _fpBrowseTo(startPath || '');
}

function _folderFieldHTML(value = '') {
  return `
    <div class="folder-input-row">
      <input type="text" id="cd-folder" value="${esc(value)}" placeholder="D:\\Formapedia\\clients\\dupont">
      <button class="btn btn-sm btn-outline" id="btn-browse-folder" type="button">📁 Browse</button>
    </div>`;
}

function _wireFolderBrowser() {
  document.getElementById('btn-browse-folder').addEventListener('click', () => {
    const cur = (document.getElementById('cd-folder').value || '').trim();
    openFolderBrowser(document.getElementById('cd-folder'), cur);
  });
}

// ── Contacts ──────────────────────────────────────────────────────────────────

let contactsData   = [];
let selContactId   = null;
let editingRuleId  = null;

async function loadContacts() {
  try {
    contactsData = await apiFetch('GET', '/api/contacts');
    renderContactList(contactsData);
  } catch (e) { console.error('loadContacts', e); }
}

function renderContactList(list) {
  const el     = document.getElementById('contacts-list-items');
  const search = (document.getElementById('contact-search').value || '').toLowerCase();
  const filt   = list.filter(c =>
    c.name.toLowerCase().includes(search) ||
    (c.emails || []).some(e => e.email.toLowerCase().includes(search))
  );

  el.innerHTML = '';
  if (!filt.length) {
    el.innerHTML = '<div class="empty-state" style="padding:30px 20px">Aucun contact.</div>';
    return;
  }
  filt.forEach(c => {
    const div = document.createElement('div');
    div.className = 'contact-list-item' + (c.id === selContactId ? ' active' : '');
    div.innerHTML = `
      <div class="contact-list-name">${esc(c.name)}</div>
      <span class="contact-list-meta">${c.type === 'client' ? 'Client' : 'Prospect'} · ${(c.emails || []).length} email${(c.emails||[]).length > 1 ? 's' : ''}</span>`;
    div.addEventListener('click', () => openContactDetail(c));
    el.appendChild(div);
  });
}

function openContactDetail(contact) {
  selContactId = contact.id;
  renderContactList(contactsData);
  document.getElementById('contacts-detail-placeholder').style.display = 'none';
  const form = document.getElementById('contacts-detail-form');
  form.style.display = '';
  form.innerHTML     = _contactDetailHTML(contact);
  _wireContactDetail(contact);
}

function _contactDetailHTML(c) {
  const emailsHtml = (c.emails || []).map(e => `
    <li class="cd-email-item">
      <span class="cd-email-addr">${esc(e.email)}</span>
      ${e.label ? `<span class="cd-email-label">${esc(e.label)}</span>` : ''}
      <button class="btn btn-sm" data-del-email="${e.id}">✕</button>
    </li>`).join('');

  return `
    <div class="contact-detail">
      <div class="contact-detail-header">
        <span class="contact-detail-title">${esc(c.name)}</span>
        <button class="btn btn-sm" id="btn-delete-contact">Supprimer</button>
      </div>
      <div class="field-group">
        <label>Nom</label>
        <input type="text" id="cd-name" value="${esc(c.name)}">
      </div>
      <div class="field-group">
        <label>Type</label>
        <select id="cd-type">
          <option value="prospect"${c.type==='prospect'?' selected':''}>Prospect</option>
          <option value="client"${c.type==='client'?' selected':''}>Client</option>
        </select>
      </div>
      <div class="field-group">
        <label>Dossier <span class="hint">chemin absolu</span></label>
        ${_folderFieldHTML(c.folder_path)}
      </div>
      <button class="btn btn-primary btn-sm" id="btn-save-contact-detail">Enregistrer</button>
      <div class="cd-emails-section">
        <div class="cd-emails-header">
          <span class="pv-label">Adresses email</span>
          <button class="btn btn-sm btn-outline" id="btn-toggle-add-email">+ Email</button>
        </div>
        <ul class="cd-email-list" id="cd-email-list">${emailsHtml || '<li class="hint" style="padding:6px 4px">Aucune adresse.</li>'}</ul>
        <div class="cd-add-email-form" id="cd-add-email-form" style="display:none">
          <input type="email" id="cd-new-email" placeholder="email@domaine.com">
          <input type="text"  id="cd-new-label" placeholder="pro / perso">
          <button class="btn btn-sm btn-primary" id="btn-confirm-add-email">Ajouter</button>
        </div>
      </div>
    </div>`;
}

function _wireContactDetail(contact) {
  _wireFolderBrowser();
  document.getElementById('btn-save-contact-detail').addEventListener('click', async () => {
    const body = {
      name:        document.getElementById('cd-name').value.trim(),
      folder_path: document.getElementById('cd-folder').value.trim(),
      type:        document.getElementById('cd-type').value,
    };
    await apiFetch('PUT', `/api/contacts/${contact.id}`, body);
    Object.assign(contact, body);
    await loadContacts();
    openContactDetail(contact);
  });

  document.getElementById('btn-delete-contact').addEventListener('click', async () => {
    if (!confirm(`Supprimer ${contact.name} ?`)) return;
    await apiFetch('DELETE', `/api/contacts/${contact.id}`);
    selContactId = null;
    document.getElementById('contacts-detail-placeholder').style.display = '';
    document.getElementById('contacts-detail-form').style.display = 'none';
    await loadContacts();
  });

  document.getElementById('btn-toggle-add-email').addEventListener('click', () => {
    const f = document.getElementById('cd-add-email-form');
    f.style.display = f.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('btn-confirm-add-email').addEventListener('click', async () => {
    const email = document.getElementById('cd-new-email').value.trim();
    const label = document.getElementById('cd-new-label').value.trim();
    if (!email) return;
    try {
      await apiFetch('POST', `/api/contacts/${contact.id}/emails`, { email, label });
      contactsData = await apiFetch('GET', '/api/contacts');
      const fresh  = contactsData.find(c => c.id === contact.id);
      if (fresh) openContactDetail(fresh);
    } catch (e) { alert(e.message); }
  });

  document.querySelectorAll('[data-del-email]').forEach(btn =>
    btn.addEventListener('click', async () => {
      await apiFetch('DELETE', `/api/contact-emails/${btn.dataset.delEmail}`);
      contact.emails = contact.emails.filter(e => e.id !== +btn.dataset.delEmail);
      openContactDetail(contact);
    })
  );
}

function openNewContactForm(prefillEmail = '') {
  selContactId = null;
  renderContactList(contactsData);
  document.getElementById('contacts-detail-placeholder').style.display = 'none';
  const form = document.getElementById('contacts-detail-form');
  form.style.display = '';
  form.innerHTML = `
    <div class="contact-detail">
      <div class="contact-detail-title">Nouveau contact</div>
      <div class="field-group">
        <label>Nom</label>
        <input type="text" id="cd-name" placeholder="Jean Dupont">
      </div>
      <div class="field-group">
        <label>Type</label>
        <select id="cd-type">
          <option value="prospect">Prospect</option>
          <option value="client">Client</option>
        </select>
      </div>
      <div class="field-group">
        <label>Dossier <span class="hint">chemin absolu vers le dossier du contact</span></label>
        ${_folderFieldHTML()}
      </div>
      <div class="field-group">
        <label>Email <span class="hint">adresse principale</span></label>
        <input type="email" id="cd-prefill-email" value="${esc(prefillEmail)}" placeholder="jean@dupont.fr">
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-create-contact">Créer</button>
        <button class="btn btn-sm" id="btn-cancel-new">Annuler</button>
      </div>
    </div>`;

  _wireFolderBrowser();
  document.getElementById('btn-create-contact').addEventListener('click', async () => {
    const body = {
      name:        document.getElementById('cd-name').value.trim(),
      folder_path: document.getElementById('cd-folder').value.trim(),
      type:        document.getElementById('cd-type').value,
    };
    if (!body.name || !body.folder_path) { alert('Nom et dossier requis.'); return; }
    const r    = await apiFetch('POST', '/api/contacts', body);
    const email = prefillEmail || (document.getElementById('cd-prefill-email')?.value || '').trim();
    if (email) await apiFetch('POST', `/api/contacts/${r.id}/emails`, { email, label: '' });
    contactsData = await apiFetch('GET', '/api/contacts');
    const fresh  = contactsData.find(c => c.id === r.id);
    if (fresh) openContactDetail(fresh);
  });

  document.getElementById('btn-cancel-new').addEventListener('click', () => {
    document.getElementById('contacts-detail-placeholder').style.display = '';
    form.style.display = 'none';
  });
}

// ── Routing rules ─────────────────────────────────────────────────────────────

let rulesData = [];

async function loadRules() {
  try {
    rulesData = await apiFetch('GET', '/api/routing-rules');
    renderRules(rulesData);
  } catch (e) { console.error('loadRules', e); }
}

function renderRules(rules) {
  const tbody = document.getElementById('rules-tbody');
  const empty = document.getElementById('rules-empty');
  tbody.innerHTML   = '';
  empty.style.display = rules.length ? 'none' : '';

  rules.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.priority}</td>
      <td>${esc(r.name_contains || '—')}</td>
      <td>${esc(r.extensions   || '—')}</td>
      <td>${esc(r.subfolder)}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-sm btn-outline" data-edit-rule="${r.id}">Éditer</button>
        <button class="btn btn-sm" data-del-rule="${r.id}">✕</button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-edit-rule]').forEach(btn =>
    btn.addEventListener('click', () =>
      openRuleForm(rulesData.find(r => r.id === +btn.dataset.editRule))
    )
  );
  tbody.querySelectorAll('[data-del-rule]').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer cette règle ?')) return;
      await apiFetch('DELETE', `/api/routing-rules/${btn.dataset.delRule}`);
      await loadRules();
    })
  );
}

function openRuleForm(rule = null) {
  editingRuleId = rule ? rule.id : null;
  document.getElementById('rule-form-title').textContent       = rule ? 'Modifier la règle' : 'Nouvelle règle';
  document.getElementById('rule-name-contains').value          = rule?.name_contains || '';
  document.getElementById('rule-extensions').value             = rule?.extensions    || '';
  document.getElementById('rule-subfolder').value              = rule?.subfolder     || '';
  document.getElementById('rule-priority').value               = rule?.priority      ?? 0;
  document.getElementById('rule-form-panel').style.display     = '';
  document.getElementById('rule-subfolder').focus();
}

// ── Contacts subtab switching ─────────────────────────────────────────────────

function switchContactsSubtab(id) {
  document.querySelectorAll('.contacts-subtabs .subtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.csub === id)
  );
  document.querySelectorAll('.csub-panel').forEach(p =>
    p.classList.toggle('active', p.id === id)
  );
  if (id === 'csub-contacts') loadContacts();
  if (id === 'csub-rules')    loadRules();
}

// ── Classify ──────────────────────────────────────────────────────────────────

let _classifyMsg = null;

async function classifyAttachments(msg) {
  _classifyMsg = msg;
  const el = document.getElementById('tray-classify');
  el.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:var(--text-muted)">Analyse en cours…</div>';

  try {
    const data = await apiFetch('POST', `/api/gmail/message/${msg.gmail_message_id}/classify`);

    if (!data.contact) {
      const senderEmail = (data.sender || '').replace(/.*<([^>]+)>.*/, '$1') || data.sender || '';
      el.innerHTML = `
        <div class="classify-no-contact">
          <strong>${esc(data.sender || 'Expéditeur inconnu')}</strong> n'est pas dans vos contacts.<br>
          <a href="#" id="link-add-sender">Ajouter comme contact</a>
        </div>`;
      document.getElementById('link-add-sender').addEventListener('click', e => {
        e.preventDefault();
        switchTab('contacts');
        openNewContactForm(senderEmail);
      });
      return;
    }

    if (!data.suggestions.length) {
      el.innerHTML = '<div class="classify-no-contact">Aucune pièce jointe trouvée.</div>';
      return;
    }

    _renderClassifyForm(el, data.contact, data.suggestions);
  } catch (e) {
    el.innerHTML = `<div class="classify-no-contact"><span class="err">${esc(e.message)}</span></div>`;
  }
}

function _renderClassifyForm(el, contact, suggestions) {
  const filesHtml = suggestions.map((s, i) => `
    <li class="classify-file-item">
      <input type="checkbox" id="clf-${i}" checked>
      <div class="classify-file-info">
        <label for="clf-${i}" class="classify-filename" title="${esc(s.name)}">${esc(s.name)}</label>
        <div class="classify-dest-row">
          <input class="classify-dest-input" id="clf-dest-${i}"
                 value="${esc(s.dest_path)}"
                 data-att-id="${esc(s.attachment_id)}"
                 data-name="${esc(s.name)}">
          <button class="btn btn-sm btn-outline clf-browse" type="button" data-idx="${i}" title="Parcourir">📁</button>
        </div>
      </div>
    </li>`).join('');

  el.innerHTML = `
    <div class="classify-contact-banner">
      <strong>${esc(contact.name)}</strong>
      <span class="hint">${esc(contact.folder_path)}</span>
    </div>
    <ul class="classify-file-list">${filesHtml}</ul>
    <div class="classify-actions">
      <button class="btn btn-primary btn-sm" id="btn-confirm-classify">Télécharger</button>
      <button class="btn btn-sm" id="btn-cancel-classify">Annuler</button>
    </div>
    <div class="classify-result" id="classify-result"></div>`;

  el.querySelectorAll('.clf-browse').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(`clf-dest-${btn.dataset.idx}`);
      openFolderBrowser(inp, contact.folder_path);
    });
  });

  document.getElementById('btn-cancel-classify').addEventListener('click', () => {
    el.innerHTML = `<div class="classify-btn-row">
      <button class="btn btn-sm btn-outline" id="btn-classer-reset">Classer les pièces jointes</button>
    </div>`;
    document.getElementById('btn-classer-reset')
      .addEventListener('click', () => classifyAttachments(_classifyMsg));
  });

  document.getElementById('btn-confirm-classify')
    .addEventListener('click', () => _confirmDownload(el, _classifyMsg.gmail_message_id));
}

async function _confirmDownload(el, gmailMessageId) {
  const items = [];
  el.querySelectorAll('.classify-file-item').forEach(li => {
    if (!li.querySelector('input[type="checkbox"]').checked) return;
    const inp = li.querySelector('.classify-dest-input');
    items.push({
      attachment_id: inp.dataset.attId,
      name:          inp.dataset.name,
      dest_path:     inp.value.trim(),
    });
  });
  if (!items.length) return;

  const checkRes = await apiFetch('POST', '/api/check_files', items);
  if (checkRes.existing.length > 0) {
    const names = checkRes.existing.map(f => f.name).join('\n');
    if (!confirm(`Ces fichiers existent déjà :\n\n${names}\n\nVoulez-vous les écraser ?`)) return;
  }

  const btn = document.getElementById('btn-confirm-classify');
  btn.disabled    = true;
  btn.textContent = 'Téléchargement…';

  try {
    const res     = await apiFetch('POST', `/api/gmail/message/${gmailMessageId}/download`, items);
    const resultEl = document.getElementById('classify-result');
    resultEl.innerHTML = res.results.map(r => `
      <div class="classify-result-item">
        <span class="${r.ok ? 'classify-ok' : 'classify-err'}">${r.ok ? '✓' : '✗'} ${esc(r.name)}</span>
        ${!r.ok ? `<span class="hint">${esc(r.error)}</span>` : ''}
      </div>`).join('');
    btn.style.display = 'none';
    document.getElementById('btn-cancel-classify').textContent = 'Fermer';
  } catch (e) {
    document.getElementById('classify-result').innerHTML =
      `<span class="err">${esc(e.message)}</span>`;
    btn.disabled    = false;
    btn.textContent = 'Réessayer';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${tab}`)
  );
  if (tab === 'mail')     loadMessages();
  if (tab === 'history')  loadHistory();
  if (tab === 'contacts') loadContacts();
}

function switchMailbox(mailbox) {
  state.currentMailbox = mailbox;
  document.querySelectorAll('.mail-subtabs .subtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mailbox === mailbox)
  );
  closeMailTray();
  loadMessages();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

document.querySelectorAll('.mail-subtabs .subtab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchMailbox(btn.dataset.mailbox))
);

document.getElementById('template-select').addEventListener('change', e => {
  if (!e.target.value) {
    state.attachments = state.attachments.filter(a => a.type === 'upload');
    renderAttachments();
    document.getElementById('payload-raw').value     = '';
    document.getElementById('preview-to').textContent = '';
  } else {
    onTemplateChange(e.target.value);
  }
});

document.getElementById('btn-preview').addEventListener('click', doPreview);
document.getElementById('btn-send').addEventListener('click',  () => composeSend(false));
document.getElementById('btn-draft').addEventListener('click', () => composeSend(true));
document.getElementById('btn-sync').addEventListener('click',       () => triggerSync(false));
document.getElementById('btn-sync-reset').addEventListener('click', () => triggerSync(false, true));
document.getElementById('btn-filter').addEventListener('click', loadMessages);

// History
document.getElementById('btn-hist-filter').addEventListener('click', loadHistory);

document.querySelectorAll('#hist-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (histState.orderBy === col) {
      histState.direction = histState.direction === 'DESC' ? 'ASC' : 'DESC';
    } else {
      histState.orderBy  = col;
      histState.direction = 'DESC';
    }
    loadHistory();
  });
});

document.getElementById('tray-close').addEventListener('click', closeMailTray);

// Contacts
document.getElementById('btn-new-contact').addEventListener('click', () => openNewContactForm());
document.getElementById('contact-search').addEventListener('input', () => renderContactList(contactsData));
document.querySelectorAll('.contacts-subtabs .subtab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchContactsSubtab(btn.dataset.csub))
);

// Routing rules
document.getElementById('btn-add-rule').addEventListener('click', () => openRuleForm());
document.getElementById('btn-save-rule').addEventListener('click', async () => {
  const body = {
    name_contains: document.getElementById('rule-name-contains').value.trim(),
    extensions:    document.getElementById('rule-extensions').value.trim(),
    subfolder:     document.getElementById('rule-subfolder').value.trim(),
    priority:      parseInt(document.getElementById('rule-priority').value) || 0,
  };
  if (!body.subfolder) { alert('Le sous-dossier est requis.'); return; }
  if (editingRuleId) {
    await apiFetch('PUT',  `/api/routing-rules/${editingRuleId}`, body);
  } else {
    await apiFetch('POST', '/api/routing-rules', body);
  }
  editingRuleId = null;
  document.getElementById('rule-form-panel').style.display = 'none';
  await loadRules();
});
document.getElementById('btn-cancel-rule').addEventListener('click', () => {
  editingRuleId = null;
  document.getElementById('rule-form-panel').style.display = 'none';
});

// Folder browser (shared picker)
document.getElementById('fp-select').addEventListener('click', () => {
  if (_fpData?.path && _fpTarget) {
    const filename = _fpTarget.dataset.name;
    _fpTarget.value = filename
      ? _fpData.path.replace(/[/\\]+$/, '') + '\\' + filename
      : _fpData.path;
  }
  document.getElementById('folder-picker').style.display = 'none';
});
document.getElementById('fp-close').addEventListener('click', () => {
  document.getElementById('folder-picker').style.display = 'none';
});
document.getElementById('folder-picker').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    e.currentTarget.style.display = 'none';
});

document.getElementById('auth-expired-close').addEventListener('click', () => {
  document.getElementById('auth-expired-modal').style.display = 'none';
});
document.getElementById('auth-expired-cancel').addEventListener('click', () => {
  document.getElementById('auth-expired-modal').style.display = 'none';
});
document.getElementById('auth-expired-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('payload-modal').style.display = 'none';
});
document.getElementById('payload-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    e.currentTarget.style.display = 'none';
});

document.getElementById('btn-add-file').addEventListener('click', () =>
  document.getElementById('file-input').click()
);

document.getElementById('file-input').addEventListener('change', e => {
  addFiles(Array.from(e.target.files));
  e.target.value = ''; // allow re-selecting the same file
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const cfg = await apiFetch('GET', '/api/config');
    state.syncIntervalHours = cfg.sync_interval_hours ?? 6;
  } catch { /* use default */ }

  await refreshStatus();
  await loadTemplateList();
})();
