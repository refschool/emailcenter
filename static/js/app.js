'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  currentMailbox:    'INBOX',
  attachments:       [],   // { type:'payload'|'upload', ... }
  syncIntervalHours: 6,
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
    const payload = await apiFetch('GET', `/api/payloads/${templateId}`);
    const data = payload.data ?? payload;
    document.getElementById('template-data').value = JSON.stringify(data, null, 2);
    if (payload.to)      document.getElementById('to-address').value   = payload.to;
    if (payload.subject) document.getElementById('email-subject').value = payload.subject;
    if (payload.cc) {
      document.getElementById('cc-addresses').value =
        Array.isArray(payload.cc) ? payload.cc.join(', ') : payload.cc;
    }

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

  let data;
  try { data = JSON.parse(document.getElementById('template-data').value || '{}'); }
  catch { setResult('Invalid JSON in template data', true); return; }

  try {
    const toAddress = document.getElementById('to-address').value.trim();
    const subject   = document.getElementById('email-subject').value.trim();
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
  const toAddress  = document.getElementById('to-address').value.trim();

  if (!templateId) { setResult('Select a template first.', true); return; }
  if (!isDraft && !toAddress) { setResult('Recipient (To) is required.', true); return; }

  let templateData, businessMeta;
  try {
    templateData = JSON.parse(document.getElementById('template-data').value || '{}');
    businessMeta = document.getElementById('business-metadata').value.trim() || '{}';
    JSON.parse(businessMeta); // validate JSON
  } catch {
    setResult('Invalid JSON — check template data or business metadata.', true);
    return;
  }

  const ccRaw  = document.getElementById('cc-addresses').value.trim();
  const ccList = ccRaw ? ccRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const subject = document.getElementById('email-subject').value.trim();

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

  const btnSend  = document.getElementById('btn-send');
  const btnDraft = document.getElementById('btn-draft');
  btnSend.disabled = btnDraft.disabled = true;
  setResult(isDraft ? 'Saving…' : 'Sending…', false);

  try {
    const r = await apiFetch('POST', '/api/compose/send', fd, true);
    setResult(
      isDraft
        ? `Draft saved (id=${r.id})`
        : `Sent successfully (id=${r.id})`,
      false
    );
    if (!isDraft) {
      // Clear form after successful send
      document.getElementById('template-data').value    = '';
      document.getElementById('business-metadata').value = '';
      document.getElementById('to-address').value        = '';
      document.getElementById('cc-addresses').value      = '';
      state.attachments = [];
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
      <td class="col-date">${fmtDate(m.date)}</td>
      <td class="col-snippet">${esc(m.snippet || '')}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function triggerSync(silent = false) {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  if (!silent) btn.textContent = 'Syncing…';

  try {
    const r = await apiFetch('POST', '/api/gmail/sync');
    document.getElementById('sync-status').textContent =
      `Synced ${r.synced} new messages`;
    await refreshStatus();
    await loadMessages();
  } catch (e) {
    if (!silent)
      document.getElementById('sync-status').textContent = `Sync error: ${e.message}`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Sync Gmail';
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
  if (tab === 'mail') loadMessages();
}

function switchMailbox(mailbox) {
  state.currentMailbox = mailbox;
  document.querySelectorAll('.subtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mailbox === mailbox)
  );
  loadMessages();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

document.querySelectorAll('.subtab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchMailbox(btn.dataset.mailbox))
);

document.getElementById('template-select').addEventListener('change', e => {
  if (!e.target.value) {
    state.attachments = state.attachments.filter(a => a.type === 'upload');
    renderAttachments();
  } else {
    onTemplateChange(e.target.value);
  }
});

document.getElementById('btn-preview').addEventListener('click', doPreview);
document.getElementById('btn-send').addEventListener('click',  () => composeSend(false));
document.getElementById('btn-draft').addEventListener('click', () => composeSend(true));
document.getElementById('btn-sync').addEventListener('click',  () => triggerSync(false));
document.getElementById('btn-filter').addEventListener('click', loadMessages);

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
