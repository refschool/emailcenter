'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  currentMailbox:    'INBOX',
  currentCategory:   'PRIMARY',
  attachments:       [],   // { type:'payload'|'upload', ... }
  syncIntervalHours: 6,
  currentPayloadFile: null,
  suggestedFolder:   null,
  composerEditor:    null,
  isComposerMode:    false,
  lastPreviewHtml:   '',
  editedHtml:        '',
  recipientSuggestTimer: null,
  everythingResults: [],
  everythingQuery:   '',
  favoriteAttachments: [],
  currentMessages:   [],
  mailSelection:     new Set(),
  lastMailSelectionIndex: null,
};

function pathFilename(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path;
}

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

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.content : '';
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(method, path, body = null, isForm = false) {
  const opts = { method };
  if (method !== 'GET' && method !== 'HEAD') {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      opts.headers = { ...(opts.headers || {}), 'X-CSRF-Token': csrfToken };
    }
    opts.credentials = 'same-origin';
  }
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' };
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

function syncSubjectFieldFromPayload(payload) {
  document.getElementById('compose-subject').value = (payload?.subject || '').trim();
}

function syncRecipientFieldFromPayload(payload) {
  document.getElementById('compose-to').value = (payload?.to || '').trim();
}

function syncPayloadSubject(payload) {
  const subject = document.getElementById('compose-subject').value.trim();
  payload.subject = subject;
  document.getElementById('payload-raw').value = JSON.stringify(payload, null, 2);
  return subject;
}

function syncPayloadRecipient(payload) {
  const toAddress = document.getElementById('compose-to').value.trim();
  payload.to = toAddress;
  document.getElementById('payload-raw').value = JSON.stringify(payload, null, 2);
  return toAddress;
}

function renderRecipientSuggestions(items) {
  const list = document.getElementById('recipient-suggestions');
  list.innerHTML = '';
  (items || []).forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.email;
    opt.label = [item.name, item.label, item.source].filter(Boolean).join(' · ');
    list.appendChild(opt);
  });
}

function scheduleRecipientSuggest() {
  clearTimeout(state.recipientSuggestTimer);
  state.recipientSuggestTimer = setTimeout(async () => {
    const q = document.getElementById('compose-to').value.trim();
    if (q.length < 2) {
      renderRecipientSuggestions([]);
      return;
    }
    try {
      const items = await apiFetch('GET', `/api/recipients/suggest?q=${encodeURIComponent(q)}`);
      renderRecipientSuggestions(items);
    } catch (e) {
      console.error('recipient suggest error', e);
    }
  }, 180);
}

async function onTemplateChange(templateId) {
  if (!templateId) return;
  try {
    const result  = await apiFetch('GET', `/api/payloads/${templateId}`);
    const payload = result.payload || {};
    state.currentPayloadFile = result.file || null;
    state.lastPreviewHtml = '';
    state.editedHtml = '';

    document.getElementById('payload-raw').value = JSON.stringify(payload, null, 2);
    syncRecipientFieldFromPayload(payload);
    syncSubjectFieldFromPayload(payload);

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

  const toAddress = syncPayloadRecipient(payload);
  const subject   = syncPayloadSubject(payload);
  const data      = payload.data || {};

  try {
    const r = await apiFetch('POST', '/api/preview', { template_id: templateId, data, to_address: toAddress, subject });
    state.lastPreviewHtml = r.html || '';
    if (!state.isComposerMode) state.editedHtml = '';
    document.getElementById('preview-frame').srcdoc = r.html;
    if (state.isComposerMode) setComposerHtml(state.lastPreviewHtml);
    await suggestComposeFolder(true);
  } catch (e) {
    setResult(`Preview error: ${e.message}`, true);
  }
}

function blankEmailHtml() {
  return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;"><p></p></div>';
}

function ensureCustomPayload() {
  const raw = document.getElementById('payload-raw');
  let payload = null;
  try { payload = JSON.parse(raw.value || '{}'); } catch { payload = {}; }
  if (!raw.value.trim() || Object.keys(payload).length === 0) {
    payload = {
      template_id: 'custom',
      to: document.getElementById('compose-to').value.trim(),
      subject: document.getElementById('compose-subject').value.trim(),
      data: {},
    };
    raw.value = JSON.stringify(payload, null, 2);
    syncRecipientFieldFromPayload(payload);
    syncSubjectFieldFromPayload(payload);
  }
}

function ensureComposerEditor() {
  if (state.composerEditor) return state.composerEditor;
  if (!window.Jodit) {
    setResult('Jodit editor is not loaded. Check your internet connection.', true);
    return null;
  }
  state.composerEditor = Jodit.make('#composer-editor', {
    height: '100%',
    minHeight: 420,
    toolbarAdaptive: false,
    askBeforePasteHTML: false,
    askBeforePasteFromWord: false,
    buttons: [
      'bold', 'italic', 'underline', '|',
      'ul', 'ol', '|',
      'font', 'fontsize', 'brush', '|',
      'left', 'center', 'right', '|',
      'link', 'table', '|',
      'undo', 'redo', '|',
      'source',
    ],
  });
  state.composerEditor.events.on('change', () => {
    state.editedHtml = state.composerEditor.value;
  });
  return state.composerEditor;
}

function setComposerHtml(html) {
  const editor = ensureComposerEditor();
  if (!editor) return;
  editor.value = html || blankEmailHtml();
  state.editedHtml = editor.value;
}

async function openComposer() {
  let html = state.lastPreviewHtml;
  const templateId = document.getElementById('template-select').value;

  if (templateId && !html) {
    await doPreview();
    html = state.lastPreviewHtml;
  }
  if (!templateId && !html) {
    ensureCustomPayload();
    html = blankEmailHtml();
  }

  setComposerHtml(html || blankEmailHtml());
  state.isComposerMode = true;
  document.getElementById('preview-title').textContent = 'Composer';
  document.getElementById('btn-compose-mode').textContent = 'Preview';
  document.getElementById('preview-frame').style.display = 'none';
  document.getElementById('composer-panel').style.display = '';
}

function closeComposer() {
  if (state.composerEditor) {
    state.editedHtml = state.composerEditor.value;
    document.getElementById('preview-frame').srcdoc = state.editedHtml;
  }
  state.isComposerMode = false;
  document.getElementById('preview-title').textContent = 'Preview';
  document.getElementById('btn-compose-mode').textContent = 'Composer';
  document.getElementById('composer-panel').style.display = 'none';
  document.getElementById('preview-frame').style.display = '';
}

async function toggleComposerMode() {
  if (state.isComposerMode) {
    closeComposer();
  } else {
    await openComposer();
  }
}

async function suggestComposeFolder(silent = false) {
  let payload;
  try { payload = JSON.parse(document.getElementById('payload-raw').value || '{}'); }
  catch {
    if (!silent) setResult('Invalid JSON in payload', true);
    return;
  }

  const templateId = document.getElementById('template-select').value || payload.template_id || '';
  const body = {
    template_id: templateId,
    to_address: syncPayloadRecipient(payload),
    subject: syncPayloadSubject(payload),
    data: payload.data || {},
  };

  const btn = document.getElementById('btn-folder-suggest');
  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = 'Analyse...';
  }

  try {
    const result = await apiFetch('POST', '/api/compose/folder-suggest', body);
    state.suggestedFolder = result.match || null;
    renderFolderSuggestion(result);
  } catch (e) {
    state.suggestedFolder = null;
    renderFolderSuggestion({ error: e.message });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Deviner dossier';
    }
  }
}

function renderFolderSuggestion(result = {}) {
  const el = document.getElementById('folder-suggestion');
  if (!el) return;

  if (result.error) {
    el.className = 'folder-suggestion folder-suggestion--empty';
    el.innerHTML = `<span class="err">${esc(result.error)}</span>`;
    return;
  }

  if (!result.match) {
    el.className = 'folder-suggestion folder-suggestion--empty';
    el.textContent = result.candidates
      ? 'Aucun contact ne correspond au sujet.'
      : 'Aucun contact disponible.';
    return;
  }

  const contact = result.match;
  const reasons = (result.reasons || []).join(' · ');
  el.className = 'folder-suggestion';
  el.innerHTML = `
    <div class="folder-suggestion-title">${esc(contact.name)} · ${esc(result.confidence || 'match')}</div>
    <div class="folder-suggestion-path">${esc(contact.folder_path)}</div>
    <div class="hint">${esc(reasons || `score ${result.score || 0}`)}</div>
    <div class="folder-suggestion-actions">
      <button class="btn btn-sm btn-outline" id="btn-browse-suggested" type="button">Browse</button>
    </div>
  `;
  document.getElementById('btn-browse-suggested').addEventListener('click', () => {
    const target = document.createElement('input');
    target.value = contact.folder_path;
    openFolderBrowser(target, contact.folder_path);
  });
}

function buildComposeFolderSuggestBodyFromFields() {
  let payload = {};
  try { payload = JSON.parse(document.getElementById('payload-raw').value || '{}'); } catch {}

  const toAddress = document.getElementById('compose-to').value.trim() || payload.to || '';
  const subject   = document.getElementById('compose-subject').value.trim() || payload.subject || '';
  return {
    template_id: document.getElementById('template-select').value || payload.template_id || '',
    to_address: toAddress,
    subject,
    data: payload.data || {},
  };
}

async function openMappedAttachmentBrowser() {
  const btn = document.getElementById('btn-attach-file');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Recherche...';

  try {
    const result = await apiFetch('POST', '/api/compose/folder-suggest', buildComposeFolderSuggestBodyFromFields());
    state.suggestedFolder = result.match || null;
    renderFolderSuggestion(result);
    openFileBrowser(result.match?.folder_path || '');
  } catch (e) {
    state.suggestedFolder = null;
    renderFolderSuggestion({ error: e.message });
    openFileBrowser('');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Compose — attachments ─────────────────────────────────────────────────────

function addFiles(files) {
  for (const file of files) {
    state.attachments.push({ type: 'upload', file, metadataText: '{}' });
  }
  renderAttachments();
}

function addLocalAttachment(path, filename = '', size = null) {
  state.attachments.push({
    type: 'payload',
    path,
    filename: filename || pathFilename(path),
    size,
  });
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
    const meta      = isUpload
      ? `<span class="att-size">${fmtBytes(att.file.size)}</span>`
      : (typeof att.size === 'number' ? `<span class="att-size">${fmtBytes(att.size)}</span>` : '');
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
  let templateId = document.getElementById('template-select').value;

  let payload;
  try { payload = JSON.parse(document.getElementById('payload-raw').value || '{}'); }
  catch { setResult('Invalid JSON in payload', true); return; }

  if (state.isComposerMode && state.composerEditor) {
    state.editedHtml = state.composerEditor.value;
  }
  const htmlOverride = (state.editedHtml || '').trim();
  if (!templateId && htmlOverride) templateId = 'custom';
  if (!templateId) { setResult('Select a template first, or use Composer for a blank email.', true); return; }

  const toAddress   = syncPayloadRecipient(payload);
  const subject     = syncPayloadSubject(payload);
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
  if (htmlOverride) fd.append('html_override', htmlOverride);

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
      document.dispatchEvent(new CustomEvent('emailcenter:attachments-sent', {
        detail: {
          attachments: payloadAtts,
          email_id: r.id,
        },
      }));
      document.getElementById('template-select').value   = '';
      document.getElementById('payload-raw').value       = '';
      document.getElementById('compose-to').value        = '';
      document.getElementById('compose-subject').value   = '';
      document.getElementById('business-metadata').value = '';
      state.attachments        = [];
      state.currentPayloadFile = null;
      state.suggestedFolder    = null;
      state.lastPreviewHtml    = '';
      state.editedHtml         = '';
      document.getElementById('preview-frame').srcdoc = '';
      if (state.composerEditor) {
        state.composerEditor.value = '';
      }
      if (state.isComposerMode) closeComposer();
      renderAttachments();
      renderFolderSuggestion();
    }
  } catch (e) {
    if (e.data?.code === 'attachment_locked') {
      setResult(
        `Piece jointe verrouillee : ${e.data.filename || 'fichier'}\n` +
        'Fermez le fichier dans Excel, attendez la fin de la synchronisation OneDrive, puis cliquez a nouveau sur Send.',
        true
      );
    } else if (e.data?.code === 'attachment_unreadable') {
      setResult(`Piece jointe illisible : ${e.data.filename || e.message}`, true);
    } else {
      setResult(e.message, true);
    }
  } finally {
    btnSend.disabled = btnDraft.disabled = false;
  }
}

// ── Mail — messages ───────────────────────────────────────────────────────────

async function loadMessages() {
  clearMailSelection();
  const params = new URLSearchParams({ mailbox: state.currentMailbox });
  const dateFrom  = document.getElementById('filter-date-from').value;
  const dateTo    = document.getElementById('filter-date-to').value;
  const recipient = document.getElementById('filter-recipient').value.trim();
  const label     = document.getElementById('filter-label').value.trim();

  if (state.currentMailbox === 'INBOX' && state.currentCategory) {
    params.set('category', state.currentCategory);
  }
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
    if (isUnread(m)) tr.classList.add('unread');
    tr.innerHTML = `
      <td title="${esc(addr)}">${esc(addr)}</td>
      <td title="${esc(m.subject)}">${esc(m.subject || '(no subject)')}</td>
      <td class="col-att">${m.has_attachment ? '📎' : ''}</td>
      <td class="col-date">${fmtDate(m.date)}</td>
      <td class="col-snippet">${esc(m.snippet || '')}</td>
    `;
    tr.addEventListener('click', () => openMailTray(m, tr));
    tbody.appendChild(tr);
  });
}

function clearMailSelection() {
  state.mailSelection.clear();
  state.lastMailSelectionIndex = null;
  syncMailSelectionControls();
}

function syncMailSelectionControls() {
  const countEl = document.getElementById('mail-selection-count');
  const btnDelete = document.getElementById('btn-delete-local');
  const selectAll = document.getElementById('mail-select-all');
  const count = state.mailSelection.size;

  if (countEl) countEl.textContent = count ? `${count} selected` : '';
  if (btnDelete) btnDelete.disabled = count === 0;

  if (selectAll) {
    const visibleIds = state.currentMessages
      .map(m => m.gmail_message_id)
      .filter(Boolean);
    const visibleSelected = visibleIds.filter(id => state.mailSelection.has(id)).length;
    selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  }
}

function handleMailSelectionClick(index, evt) {
  const msg = state.currentMessages[index];
  if (!msg || !msg.gmail_message_id) return;

  const isRange = (evt.shiftKey || evt.ctrlKey || evt.metaKey) && state.lastMailSelectionIndex != null;

  if (isRange) {
    const start = Math.min(state.lastMailSelectionIndex, index);
    const end = Math.max(state.lastMailSelectionIndex, index);
    for (let i = start; i <= end; i++) {
      const row = state.currentMessages[i];
      if (row?.gmail_message_id) state.mailSelection.add(row.gmail_message_id);
    }
    state.lastMailSelectionIndex = index;
  } else {
    if (state.mailSelection.has(msg.gmail_message_id)) {
      state.mailSelection.delete(msg.gmail_message_id);
    } else {
      state.mailSelection.add(msg.gmail_message_id);
    }
    state.lastMailSelectionIndex = index;
  }

  renderMessages(state.currentMessages);
}

async function deleteSelectedLocalMessages() {
  const ids = Array.from(state.mailSelection);
  if (!ids.length) return;

  if (!confirm(`Delete ${ids.length} local message(s) from EmailCenter?`)) return;

  try {
    await apiFetch('POST', '/api/gmail/messages/delete-local', { gmail_message_ids: ids });
    closeMailTray();
    clearMailSelection();
    await loadMessages();
  } catch (e) {
    setResult(`Local delete error: ${e.message}`, true);
  }
}

function renderMessages(msgs) {
  state.currentMessages = Array.isArray(msgs) ? msgs : [];
  const tbody = document.getElementById('mail-tbody');
  const empty = document.getElementById('mail-empty');
  tbody.innerHTML = '';

  if (!state.currentMessages.length) {
    empty.style.display = '';
    syncMailSelectionControls();
    return;
  }
  empty.style.display = 'none';

  const isSent = state.currentMailbox === 'SENT';

  state.currentMessages.forEach((m, idx) => {
    const addr = isSent
      ? (m.to_address   || 'â€”')
      : (m.from_address || 'â€”');

    const tr = document.createElement('tr');
    tr.dataset.index = String(idx);
    tr.dataset.messageId = m.gmail_message_id || '';
    if (state.mailSelection.has(m.gmail_message_id)) tr.classList.add('is-selected');
    if (isUnread(m)) tr.classList.add('unread');
    tr.innerHTML = `
      <td>
        <input type="checkbox" class="mail-row-check" data-mail-select="${idx}" ${state.mailSelection.has(m.gmail_message_id) ? 'checked' : ''}>
      </td>
      <td title="${esc(addr)}">${esc(addr)}</td>
      <td title="${esc(m.subject)}">${esc(m.subject || '(no subject)')}</td>
      <td class="col-att">${m.has_attachment ? 'ðŸ“Ž' : ''}</td>
      <td class="col-date">${fmtDate(m.date)}</td>
      <td class="col-snippet">${esc(m.snippet || '')}</td>
    `;
    tr.addEventListener('click', () => openMailTray(m, tr));
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-mail-select]').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleMailSelectionClick(Number(cb.dataset.mailSelect), e);
    });
  });

  syncMailSelectionControls();
}

function isUnread(m) {
  return typeof m.labels === 'string' && m.labels.includes('UNREAD');
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

async function openMailTray(msg, rowEl) {
  document.getElementById('tray-subject').textContent = msg.subject || '(no subject)';

  if (isUnread(msg)) markAsRead(msg, rowEl);

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

async function markAsRead(msg, rowEl) {
  if (!msg.gmail_message_id) return;
  try {
    await apiFetch('POST', `/api/gmail/message/${msg.gmail_message_id}/read`);
    // Reflect locally so the row stops showing as unread without a full reload
    rowEl?.classList.remove('unread');
    try {
      msg.labels = JSON.stringify(
        JSON.parse(msg.labels).filter(l => l !== 'UNREAD')
      );
    } catch { /* leave labels as-is */ }
  } catch (e) {
    console.error('markAsRead error', e);
  }
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
let _fpMode   = 'folder';
let _fpView   = 'browse';
let _fpSearchState = {
  query: '',
  offset: 0,
  total: 0,
  pageSize: 0,
  hasPrev: false,
  hasNext: false,
  prevOffset: null,
  nextOffset: null,
  items: [],
};

async function _fpBrowseTo(path) {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (_fpMode === 'file') params.set('include_files', '1');
  const qs   = params.toString();
  const url  = qs ? `/api/browse?${qs}` : '/api/browse';
  const list = document.getElementById('fp-list');
  list.innerHTML = '<li class="fp-message">Chargement…</li>';
  try {
    _fpData = await apiFetch('GET', url);
    document.getElementById('fp-current').textContent = _fpData.path || 'Lecteurs disponibles';
    if (_fpData.entries.length) {
      list.innerHTML = _fpData.entries
        .map(e => `
          <li class="fp-item fp-item--${esc(e.type || 'dir')}"
              data-path="${esc(e.path)}"
              data-type="${esc(e.type || 'dir')}"
              data-name="${esc(e.name)}"
              data-size="${Number.isFinite(e.size) ? e.size : ''}">
            <span>${esc(e.name)}</span>
            ${e.type === 'file' && Number.isFinite(e.size) ? `<span class="fp-size">${fmtBytes(e.size)}</span>` : ''}
          </li>`)
        .join('');
      list.querySelectorAll('.fp-item').forEach(li => {
        li.addEventListener('click', () => {
          if (li.dataset.type === 'file') {
            const size = li.dataset.size ? Number(li.dataset.size) : null;
            addLocalAttachment(li.dataset.path, li.dataset.name, size);
            document.getElementById('folder-picker').style.display = 'none';
          } else {
            _fpBrowseTo(li.dataset.path);
          }
        });
      });
    } else {
      list.innerHTML = `<li class="fp-message">${_fpMode === 'file' ? 'Aucun fichier ou sous-dossier' : 'Aucun sous-dossier'}</li>`;
    }
    const upBtn = document.getElementById('fp-up');
    upBtn.disabled = _fpData.parent === null;
    upBtn.onclick  = () => _fpBrowseTo(_fpData.parent ?? '');
  } catch (e) {
    list.innerHTML = `<li class="fp-message err">${esc(e.message)}</li>`;
  }
}

function openFolderBrowser(targetInput, startPath = '') {
  _fpMode = 'folder';
  _fpTarget = targetInput;
  document.getElementById('fp-select').style.display = '';
  document.getElementById('fp-select').textContent = 'Selectionner ce dossier';
  document.getElementById('folder-picker').style.display = '';
  _fpBrowseTo(startPath || '');
}

function openFileBrowser(startPath = '') {
  _fpMode = 'file';
  _fpTarget = null;
  document.getElementById('fp-select').style.display = 'none';
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

function _fpSetSearchMeta(text = '', isErr = false) {
  const meta = document.getElementById('fp-search-meta');
  meta.textContent = text;
  meta.className = isErr ? 'fp-search-meta err' : 'fp-search-meta';
}

function _fpSetPagerState(stateObj) {
  const pager = document.getElementById('fp-pager');
  const prevBtn = document.getElementById('fp-page-prev');
  const nextBtn = document.getElementById('fp-page-next');
  const meta = document.getElementById('fp-pager-meta');

  const hasResults = Boolean(stateObj && stateObj.query && Array.isArray(stateObj.items) && stateObj.items.length);
  pager.style.display = hasResults ? '' : 'none';
  if (!hasResults) {
    meta.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const start = stateObj.offset + 1;
  const end = stateObj.offset + stateObj.pageSize;
  const shownEnd = stateObj.total ? Math.min(end, stateObj.total) : end;
  meta.textContent = `${start} - ${shownEnd} / ${stateObj.total || shownEnd}`;
  prevBtn.disabled = !stateObj.hasPrev;
  nextBtn.disabled = !stateObj.hasNext;
}

function _fpRenderFavoriteAttachments(items) {
  const select = document.getElementById('fp-favorites-select');
  const wrap = document.getElementById('fp-favorites-wrap');
  const list = Array.isArray(items) ? items : [];
  state.favoriteAttachments = list;

  if (!list.length) {
    wrap.style.display = '';
    select.innerHTML = '<option value="">Aucun favori</option>';
    select.disabled = true;
    return;
  }

  wrap.style.display = '';
  select.disabled = false;
  select.innerHTML = [
    '<option value="">Fichier préféré...</option>',
    ...list.map(item => `<option value="${esc(item.path)}">${esc(pathFilename(item.path))} (${Number(item.frequency) || 0})</option>`)
  ].join('');
}

async function _fpLoadFavoriteAttachments() {
  const select = document.getElementById('fp-favorites-select');
  const wrap = document.getElementById('fp-favorites-wrap');
  wrap.style.display = '';
  select.disabled = true;
  select.innerHTML = '<option value="">Chargement...</option>';

  try {
    const data = await apiFetch('GET', '/api/attachments/favorites');
    _fpRenderFavoriteAttachments(data.items || []);
  } catch (e) {
    select.innerHTML = `<option value="">${esc(e.message)}</option>`;
    select.disabled = true;
  }
}

function _fpRenderEntries(entries, emptyMessage) {
  const list = document.getElementById('fp-list');
  if (!entries.length) {
    list.innerHTML = `<li class="fp-message">${emptyMessage}</li>`;
    return;
  }

  list.innerHTML = entries
    .map(e => `
      <li class="fp-item fp-item--${esc(e.type || 'dir')}"
          data-path="${esc(e.path)}"
          data-type="${esc(e.type || 'dir')}"
          data-name="${esc(e.name)}"
          data-size="${Number.isFinite(e.size) ? e.size : ''}">
        <div class="fp-item-body">
          <span class="fp-item-label">${esc(e.name)}</span>
          ${e.path ? `<span class="fp-item-path">${esc(e.path)}</span>` : ''}
        </div>
        ${e.type === 'file' && Number.isFinite(e.size) ? `<span class="fp-size">${fmtBytes(e.size)}</span>` : ''}
      </li>`)
    .join('');

  list.querySelectorAll('.fp-item').forEach(li => {
    li.addEventListener('click', () => {
      if (li.dataset.type === 'file') {
        const size = li.dataset.size ? Number(li.dataset.size) : null;
        addLocalAttachment(li.dataset.path, li.dataset.name, size);
        document.getElementById('folder-picker').style.display = 'none';
      } else {
        _fpView = 'browse';
        _fpBrowseTo(li.dataset.path);
      }
    });
  });
}

function _fpConfigureView() {
  const isFileMode = _fpMode === 'file';
  document.getElementById('fp-select').style.display = isFileMode ? 'none' : '';
  document.getElementById('fp-search-wrap').style.display = isFileMode ? '' : 'none';
  document.getElementById('fp-favorites-wrap').style.display = isFileMode ? '' : 'none';
  document.getElementById('fp-up').style.display = _fpView === 'browse' ? '' : 'none';
  document.getElementById('fp-pager').style.display = _fpView === 'search' ? '' : 'none';
  document.getElementById('fp-current').textContent = _fpView === 'search'
    ? (_fpSearchState.query ? `Everything: ${_fpSearchState.query}` : 'Everything')
    : (_fpData?.path || 'Lecteurs disponibles');

  if (!isFileMode) {
    document.getElementById('fp-search').value = '';
    _fpSetSearchMeta('');
  }
}

function _fpRenderSearchPage(data) {
  const list = document.getElementById('fp-list');
  _fpSearchState = {
    query: data.query || '',
    offset: Number(data.offset) || 0,
    total: Number(data.total) || 0,
    pageSize: Number(data.page_size) || (data.items || []).length,
    hasPrev: Boolean(data.has_prev),
    hasNext: Boolean(data.has_next),
    prevOffset: data.prev_offset ?? null,
    nextOffset: data.next_offset ?? null,
    items: data.items || [],
  };

  _fpRenderEntries(
    _fpSearchState.items,
    'Aucun resultat.'
  );
  _fpSetSearchMeta(`${_fpSearchState.items.length} resultat(s)`);
  _fpSetPagerState(_fpSearchState);
}

async function _fpSearchEverything(query, offset = 0) {
  const q = String(query || '').trim();
  const list = document.getElementById('fp-list');

  if (q.length < 3) {
    _fpSetSearchMeta('Entrer au moins 3 caracteres.');
    _fpSetPagerState(null);
    return;
  }

  _fpView = 'search';
  _fpSearchState.query = q;
  _fpSearchState.offset = offset;
  _fpConfigureView();
  list.innerHTML = '<li class="fp-message">Recherche Everything...</li>';
  _fpSetSearchMeta('Chargement...');
  _fpSetPagerState(null);

  try {
    const data = await apiFetch('GET', `/api/everything/search?q=${encodeURIComponent(q)}&offset=${offset}`);
    _fpRenderSearchPage(data);
  } catch (e) {
    _fpSearchState.items = [];
    list.innerHTML = `<li class="fp-message err">${esc(e.message)}</li>`;
    _fpSetSearchMeta(e.message, true);
    _fpSetPagerState(null);
  }
}

async function _fpBrowseTo(path) {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (_fpMode === 'file') params.set('include_files', '1');
  const qs   = params.toString();
  const url  = qs ? `/api/browse?${qs}` : '/api/browse';
  const list = document.getElementById('fp-list');
  _fpView = 'browse';
  _fpConfigureView();
  list.innerHTML = '<li class="fp-message">Chargement...</li>';
  try {
    _fpData = await apiFetch('GET', url);
    _fpConfigureView();
    _fpRenderEntries(
      _fpData.entries,
      _fpMode === 'file' ? 'Aucun fichier ou sous-dossier' : 'Aucun sous-dossier'
    );
    const upBtn = document.getElementById('fp-up');
    upBtn.disabled = _fpData.parent === null;
    upBtn.onclick  = () => _fpBrowseTo(_fpData.parent ?? '');
  } catch (e) {
    list.innerHTML = `<li class="fp-message err">${esc(e.message)}</li>`;
  }
}

function openFolderBrowser(targetInput, startPath = '') {
  _fpMode = 'folder';
  _fpTarget = targetInput;
  document.getElementById('fp-select').textContent = 'Selectionner ce dossier';
  document.getElementById('folder-picker').style.display = '';
  _fpConfigureView();
  _fpBrowseTo(startPath || '');
}

function openFileBrowser(startPath = '') {
  _fpMode = 'file';
  _fpTarget = null;
  _fpSearchState = {
    query: '',
    offset: 0,
    total: 0,
    pageSize: 0,
    hasPrev: false,
    hasNext: false,
    prevOffset: null,
    nextOffset: null,
    items: [],
  };
  document.getElementById('folder-picker').style.display = '';
  document.getElementById('fp-search').value = '';
  _fpSetSearchMeta('Entrer un terme puis valider avec Entree.');
  _fpSetPagerState(null);
  _fpConfigureView();
  _fpLoadFavoriteAttachments();
  _fpBrowseTo(startPath || '');
}

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
  if (mailbox === 'INBOX') {
    state.currentCategory = 'PRIMARY';
    document.querySelectorAll('.mail-categories .cat-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.category === 'PRIMARY')
    );
  }
  document.querySelectorAll('.mail-subtabs .subtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mailbox === mailbox)
  );
  document.getElementById('mail-categories').style.display =
    mailbox === 'INBOX' ? '' : 'none';
  closeMailTray();
  loadMessages();
}

function switchCategory(category) {
  state.currentCategory = category;
  document.querySelectorAll('.mail-categories .cat-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.category === category)
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

document.querySelectorAll('.mail-categories .cat-chip').forEach(btn =>
  btn.addEventListener('click', () => switchCategory(btn.dataset.category))
);

document.getElementById('template-select').addEventListener('change', e => {
  if (!e.target.value) {
    state.attachments = state.attachments.filter(a => a.type === 'upload');
    renderAttachments();
    document.getElementById('payload-raw').value     = '';
    document.getElementById('compose-to').value      = '';
    document.getElementById('compose-subject').value = '';
  } else {
    onTemplateChange(e.target.value);
  }
});

document.getElementById('btn-preview').addEventListener('click', doPreview);
document.getElementById('btn-compose-mode').addEventListener('click', toggleComposerMode);
document.getElementById('btn-folder-suggest').addEventListener('click', () => suggestComposeFolder(false));
document.getElementById('compose-subject').addEventListener('input', () => {
  try {
    const payload = JSON.parse(document.getElementById('payload-raw').value || '{}');
    syncPayloadSubject(payload);
  } catch {
    // Keep typing fluid if the JSON payload is temporarily invalid.
  }
});
document.getElementById('compose-to').addEventListener('input', () => {
  scheduleRecipientSuggest();
  try {
    const payload = JSON.parse(document.getElementById('payload-raw').value || '{}');
    syncPayloadRecipient(payload);
  } catch {
    // Keep typing fluid if the JSON payload is temporarily invalid.
  }
});
document.getElementById('btn-send').addEventListener('click',  () => composeSend(false));
document.getElementById('btn-draft').addEventListener('click', () => composeSend(true));
document.getElementById('btn-delete-local').addEventListener('click', (e) => {
  e.preventDefault();
  deleteSelectedLocalMessages();
});
document.getElementById('mail-select-all').addEventListener('change', (e) => {
  if (!state.currentMessages.length) return;
  if (e.target.checked) {
    state.currentMessages.forEach(m => {
      if (m.gmail_message_id) state.mailSelection.add(m.gmail_message_id);
    });
  } else {
    state.mailSelection.clear();
  }
  state.lastMailSelectionIndex = null;
  renderMessages(state.currentMessages);
});
document.addEventListener('emailcenter:attachments-sent', async () => {
  try {
    await apiFetch('POST', '/api/attachments/favorites/rebuild', {});
    await _fpLoadFavoriteAttachments();
  } catch (e) {
    console.error('favorite rebuild error', e);
  }
});
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
document.getElementById('fp-search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  _fpSearchEverything(e.target.value);
});
document.getElementById('fp-favorites-select').addEventListener('change', e => {
  const path = e.target.value;
  if (!path) return;
  addLocalAttachment(path, pathFilename(path));
  document.getElementById('folder-picker').style.display = 'none';
  e.target.value = '';
});
document.getElementById('fp-page-prev').addEventListener('click', () => {
  if (!_fpSearchState.hasPrev) return;
  _fpSearchEverything(_fpSearchState.query, _fpSearchState.prevOffset || 0);
});
document.getElementById('fp-page-next').addEventListener('click', () => {
  if (!_fpSearchState.hasNext) return;
  _fpSearchEverything(_fpSearchState.query, _fpSearchState.nextOffset || 0);
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
document.getElementById('btn-attach-file').addEventListener('click', openMappedAttachmentBrowser);

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
  await openComposer();
})();
