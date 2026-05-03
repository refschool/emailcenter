import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, redirect, request, jsonify, send_from_directory, send_file

from auth import build_auth_flow, exchange_and_save, is_authenticated, get_credentials
from config import config
from database import get_conn, apply_migrations
from template_engine import render_template
from mailer import send_email
import gmail_sync
import payload_watcher

app = Flask(__name__, static_folder='static', static_url_path='')

REDIRECT_URI = 'http://localhost:5000/oauth2callback'
_flows: dict = {}

apply_migrations()
payload_watcher.ensure_dirs()


# ── Static ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/auth')
def auth():
    flow = build_auth_flow(REDIRECT_URI)
    auth_url, state = flow.authorization_url(prompt='consent')
    _flows[state] = flow
    return redirect(auth_url)


@app.route('/oauth2callback')
def oauth2callback():
    state = request.args.get('state')
    flow = _flows.pop(state, None)
    if not flow:
        return 'Invalid state — go back to /auth', 400
    exchange_and_save(flow, request.url)
    return redirect('/')


# ── Status & config ───────────────────────────────────────────────────────────

@app.route('/api/status')
def api_status():
    conn = get_conn()
    row = conn.execute('SELECT last_synced_at FROM sync_state WHERE id = 1').fetchone()
    conn.close()
    return jsonify({
        'authenticated': is_authenticated(),
        'last_synced_at': row['last_synced_at'] if row else None,
    })


@app.route('/api/config')
def api_config():
    return jsonify({'sync_interval_hours': config.gmail_sync_interval_hours})


# ── File preview ─────────────────────────────────────────────────────────────

@app.route('/api/file')
def api_file():
    raw          = request.args.get('path', '')
    project_root = Path(__file__).parent.resolve()
    p    = Path(raw).expanduser()
    path = p.resolve() if p.is_absolute() else (project_root / p).resolve()
    if not path.exists():
        return 'Not found', 404
    return send_file(path, conditional=True)


# ── Templates & payloads ──────────────────────────────────────────────────────

@app.route('/api/templates')
def api_templates():
    tmpl_dir = Path(config.templates_dir)
    return jsonify([p.stem for p in sorted(tmpl_dir.glob('*.html'))])


@app.route('/api/payloads')
def api_payloads_list():
    files = sorted(payload_watcher.PAYLOADS_DIR.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    result = []
    for p in files:
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            data = {}
        result.append({'file': p.name, 'payload': data})
    return jsonify(result)


@app.route('/api/payloads/<template_id>')
def api_payload(template_id):
    candidates = sorted(
        payload_watcher.PAYLOADS_DIR.glob(f'{template_id}_*.json'),
        key=lambda p: p.stat().st_mtime,
    )
    path = candidates[0] if candidates else payload_watcher.PAYLOADS_DIR / f'{template_id}.json'
    if not path.exists():
        return jsonify({'file': None, 'payload': {}})
    return jsonify({
        'file':    path.name,
        'payload': json.loads(path.read_text(encoding='utf-8')),
    })


# ── Webhook ───────────────────────────────────────────────────────────────────

@app.route('/api/webhook/payload', methods=['POST'])
def api_webhook_payload():
    secret = config.webhook_secret
    if secret:
        auth = request.headers.get('Authorization', '')
        if auth != f'Bearer {secret}':
            return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(force=True, silent=True)
    if not payload:
        return jsonify({'error': 'Invalid JSON body'}), 400

    missing = [f for f in ('template_id', 'to') if not payload.get(f)]
    if missing:
        return jsonify({'error': f'Missing fields: {missing}'}), 400

    ts       = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    filename = f'{payload["template_id"]}_{ts}.json'
    dest     = payload_watcher.PAYLOADS_DIR / filename
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')

    return jsonify({'status': 'queued', 'file': filename}), 202


# ── Preview ───────────────────────────────────────────────────────────────────

@app.route('/api/preview', methods=['POST'])
def api_preview():
    body = request.get_json()
    data = body.get('data', {})
    data.setdefault('recipient_email', body.get('to_address', ''))
    try:
        subject, html = render_template(body['template_id'], data)
        subject = _resolve_subject(body.get('subject', ''), subject, data)
        return jsonify({'subject': subject, 'html': html})
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve_subject(override: str, fallback: str, data: dict) -> str:
    """Render the subject from the payload field (supports {{ variables }}),
    falling back to the subject extracted from the template."""
    from jinja2 import Environment
    raw = override.strip() if override.strip() else fallback
    try:
        return Environment(autoescape=False).from_string(raw).render(**data)
    except Exception:
        return raw


# ── Compose ───────────────────────────────────────────────────────────────────

@app.route('/api/compose/send', methods=['POST'])
def api_compose_send():
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated. Visit /auth first.'}), 401

    template_id      = request.form.get('template_id', '')
    to_address       = request.form.get('to_address', '').strip()
    subject_override = request.form.get('subject', '').strip()
    cc_raw          = request.form.get('cc_addresses', '[]')
    template_data_s = request.form.get('template_data', '{}')
    business_meta   = request.form.get('business_metadata', '{}')
    is_draft        = request.form.get('is_draft', '0') == '1'
    payload_file    = request.form.get('payload_file', '').strip()

    try:
        template_data = json.loads(template_data_s)
        cc_list = json.loads(cc_raw)
    except ValueError as e:
        return jsonify({'error': f'JSON parse error: {e}'}), 400

    template_data.setdefault('recipient_email', to_address)

    try:
        subject, html_body = render_template(template_id, template_data)
        subject = _resolve_subject(subject_override, subject, template_data)
    except Exception as e:
        return jsonify({'error': f'Template error: {e}'}), 400

    att_dir      = Path(config.attachments_dir)
    project_root = Path(__file__).parent.resolve()
    saved_attachments = []
    att_rows = []

    # Default attachments declared in payload (paths relative to project root)
    try:
        default_atts = json.loads(request.form.get('default_attachments', '[]'))
    except ValueError:
        default_atts = []

    import mimetypes
    for da in default_atts:
        p = Path(da['path']).expanduser()
        path = p.resolve() if p.is_absolute() else (project_root / p).resolve()
        if not path.exists():
            continue
        mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        saved_attachments.append({
            'path': str(path),
            'filename': da.get('filename', path.name),
            'mime_type': mime,
        })

    # Uploaded attachments (from file picker)
    for key, file in request.files.items():
        if not file.filename:
            continue
        ext = Path(file.filename).suffix
        stored_name = f'{uuid.uuid4().hex}{ext}'
        dest = att_dir / stored_name
        file.save(dest)
        mime = file.mimetype or 'application/octet-stream'
        meta_raw = request.form.get(f'metadata_{key}', '{}')
        saved_attachments.append({
            'path': str(dest),
            'filename': file.filename,
            'mime_type': mime,
        })
        att_rows.append({
            'original_name': file.filename,
            'stored_name': stored_name,
            'mime_type': mime,
            'size_bytes': dest.stat().st_size,
            'metadata': meta_raw,
        })

    payload_json = json.dumps({
        'template_id': template_id,
        'to':          to_address,
        'cc':          cc_list,
        'subject':     subject_override,
        'attachments': default_atts,
        'data':        template_data,
    })

    if is_draft:
        conn = get_conn()
        with conn:
            cur = conn.execute("""
                INSERT INTO composed_emails
                    (template_id, to_address, cc_addresses, subject,
                     template_data, business_metadata, is_draft, status, payload)
                VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?)
            """, (template_id, to_address, cc_raw, subject,
                  json.dumps(template_data), business_meta, payload_json))
            eid = cur.lastrowid
            _insert_attachments(conn, eid, att_rows)
        conn.close()
        return jsonify({'status': 'draft', 'id': eid})

    try:
        result = send_email(
            to=to_address,
            subject=subject,
            html_body=html_body,
            cc=cc_list or None,
            attachments=saved_attachments or None,
        )
        gmail_id = result.get('id')
        sent_at = datetime.now(timezone.utc).isoformat()

        conn = get_conn()
        with conn:
            cur = conn.execute("""
                INSERT INTO composed_emails
                    (template_id, to_address, cc_addresses, subject,
                     template_data, business_metadata, is_draft,
                     status, sent_at, gmail_message_id, payload)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'sent', ?, ?, ?)
            """, (template_id, to_address, cc_raw, subject,
                  json.dumps(template_data), business_meta, sent_at, gmail_id, payload_json))
            eid = cur.lastrowid
            _insert_attachments(conn, eid, att_rows)
        conn.close()
        if payload_file:
            (payload_watcher.PAYLOADS_DIR / Path(payload_file).name).unlink(missing_ok=True)
        return jsonify({'status': 'sent', 'id': eid, 'gmail_message_id': gmail_id})

    except Exception as e:
        conn = get_conn()
        with conn:
            conn.execute("""
                INSERT INTO composed_emails
                    (template_id, to_address, cc_addresses, subject,
                     template_data, business_metadata, is_draft, status, error_message, payload)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'failed', ?, ?)
            """, (template_id, to_address, cc_raw, subject,
                  json.dumps(template_data), business_meta, str(e), payload_json))
        conn.close()
        return jsonify({'error': str(e)}), 500


def _insert_attachments(conn, email_id: int, att_rows: list) -> None:
    for att in att_rows:
        conn.execute("""
            INSERT INTO attachments
                (composed_email_id, original_name, stored_name,
                 mime_type, size_bytes, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (email_id, att['original_name'], att['stored_name'],
              att['mime_type'], att['size_bytes'], att['metadata']))


# ── Composed emails history ───────────────────────────────────────────────────

_COMPOSED_COLS = {'id', 'template_id', 'to_address', 'subject', 'status', 'sent_at', 'created_at', 'is_draft'}

@app.route('/api/composed')
def api_composed():
    date_from = request.args.get('date_from', '').strip()
    date_to   = request.args.get('date_to',   '').strip()
    order_by  = request.args.get('order_by',  'created_at')
    direction = request.args.get('direction',  'DESC').upper()

    if order_by  not in _COMPOSED_COLS: order_by  = 'created_at'
    if direction not in ('ASC', 'DESC'): direction = 'DESC'

    q      = 'SELECT * FROM composed_emails WHERE 1=1'
    params: list = []

    if date_from:
        q += ' AND created_at >= ?'
        params.append(date_from)
    if date_to:
        q += ' AND created_at <= ?'
        params.append(date_to + 'T23:59:59')

    q += f' ORDER BY {order_by} {direction} LIMIT 100'

    conn = get_conn()
    rows = [dict(r) for r in conn.execute(q, params).fetchall()]
    conn.close()
    return jsonify(rows)


# ── Gmail ─────────────────────────────────────────────────────────────────────

@app.route('/api/gmail/sync', methods=['POST'])
def api_gmail_sync():
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated'}), 401
    try:
        count = gmail_sync.sync()
        return jsonify({'synced': count})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/gmail/message/<gmail_message_id>')
def api_gmail_message(gmail_message_id):
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated'}), 401
    try:
        from googleapiclient.discovery import build
        service = build('gmail', 'v1', credentials=get_credentials())
        msg     = service.users().messages().get(
            userId='me', id=gmail_message_id, format='full'
        ).execute()

        attachments = []

        def _walk(parts):
            for part in parts or []:
                if part.get('filename'):
                    attachments.append({
                        'name':      part['filename'],
                        'mime_type': part.get('mimeType', ''),
                        'size':      part.get('body', {}).get('size', 0),
                    })
                _walk(part.get('parts', []))

        _walk(msg.get('payload', {}).get('parts', []))
        return jsonify({'attachments': attachments})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/gmail/messages')
def api_gmail_messages():
    mailbox   = request.args.get('mailbox', 'INBOX')
    date_from = request.args.get('date_from', '').strip()
    date_to   = request.args.get('date_to', '').strip()
    recipient = request.args.get('recipient', '').strip()
    label     = request.args.get('label', '').strip()

    q = 'SELECT * FROM gmail_messages WHERE mailbox = ?'
    params: list = [mailbox]

    if date_from:
        q += ' AND date >= ?'
        params.append(date_from)
    if date_to:
        q += ' AND date <= ?'
        params.append(date_to + 'T23:59:59')
    if recipient:
        q += ' AND (to_address LIKE ? OR from_address LIKE ?)'
        params += [f'%{recipient}%', f'%{recipient}%']
    if label:
        q += ' AND labels LIKE ?'
        params.append(f'%{label}%')

    q += ' ORDER BY date DESC LIMIT 100'

    conn = get_conn()
    rows = [dict(r) for r in conn.execute(q, params).fetchall()]
    conn.close()
    return jsonify(rows)


# ── Filesystem browser ───────────────────────────────────────────────────────

def _is_accessible_dir(p: Path) -> bool:
    try:
        return p.is_dir()
    except (PermissionError, OSError):
        return False


@app.route('/api/browse')
def api_browse():
    import platform
    raw = request.args.get('path', '').strip()

    if not raw:
        if platform.system() == 'Windows':
            import string
            entries = [
                {'name': f'{d}:', 'path': f'{d}:\\'}
                for d in string.ascii_uppercase
                if Path(f'{d}:\\').exists()
            ]
            return jsonify({'path': '', 'parent': None, 'entries': entries})
        raw = '/'

    p = Path(raw)
    if not p.exists() or not p.is_dir():
        return jsonify({'error': 'Not found'}), 404

    try:
        entries = sorted(
            [{'name': c.name, 'path': str(c)} for c in p.iterdir() if _is_accessible_dir(c)],
            key=lambda e: e['name'].lower(),
        )
        if p.parent == p:
            parent = '' if platform.system() == 'Windows' else None
        else:
            parent = str(p.parent)

        return jsonify({'path': str(p), 'parent': parent, 'entries': entries})
    except PermissionError:
        return jsonify({'error': 'Permission denied'}), 403


# ── Contacts ──────────────────────────────────────────────────────────────────

import re as _re

def _extract_email(addr: str) -> str:
    m = _re.search(r'<([^>]+)>', addr or '')
    return m.group(1).strip().lower() if m else (addr or '').strip().lower()


@app.route('/api/contacts')
def api_contacts():
    conn = get_conn()
    contacts = [dict(r) for r in conn.execute(
        'SELECT * FROM contacts ORDER BY name'
    ).fetchall()]
    for c in contacts:
        c['emails'] = [dict(r) for r in conn.execute(
            'SELECT * FROM contact_emails WHERE contact_id = ?', (c['id'],)
        ).fetchall()]
    conn.close()
    return jsonify(contacts)


@app.route('/api/contacts', methods=['POST'])
def api_create_contact():
    body = request.get_json()
    if not body.get('name') or not body.get('folder_path'):
        return jsonify({'error': 'name and folder_path required'}), 400
    conn = get_conn()
    with conn:
        cur = conn.execute(
            'INSERT INTO contacts (name, folder_path, type) VALUES (?, ?, ?)',
            (body['name'], body['folder_path'], body.get('type', 'prospect'))
        )
        cid = cur.lastrowid
    conn.close()
    return jsonify({'id': cid}), 201


@app.route('/api/contacts/<int:cid>', methods=['PUT'])
def api_update_contact(cid):
    body = request.get_json()
    conn = get_conn()
    with conn:
        conn.execute(
            'UPDATE contacts SET name=?, folder_path=?, type=? WHERE id=?',
            (body['name'], body['folder_path'], body.get('type', 'prospect'), cid)
        )
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/contacts/<int:cid>', methods=['DELETE'])
def api_delete_contact(cid):
    conn = get_conn()
    with conn:
        conn.execute('DELETE FROM contacts WHERE id=?', (cid,))
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/contacts/<int:cid>/emails', methods=['POST'])
def api_add_contact_email(cid):
    body = request.get_json()
    if not body.get('email'):
        return jsonify({'error': 'email required'}), 400
    conn = get_conn()
    try:
        with conn:
            cur = conn.execute(
                'INSERT INTO contact_emails (contact_id, email, label) VALUES (?, ?, ?)',
                (cid, body['email'].strip().lower(), body.get('label', ''))
            )
            eid = cur.lastrowid
        conn.close()
        return jsonify({'id': eid}), 201
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 409


@app.route('/api/contact-emails/<int:eid>', methods=['DELETE'])
def api_delete_contact_email(eid):
    conn = get_conn()
    with conn:
        conn.execute('DELETE FROM contact_emails WHERE id=?', (eid,))
    conn.close()
    return jsonify({'ok': True})


# ── Routing rules ─────────────────────────────────────────────────────────────

@app.route('/api/routing-rules')
def api_routing_rules():
    conn = get_conn()
    rules = [dict(r) for r in conn.execute(
        'SELECT * FROM routing_rules ORDER BY priority DESC, id'
    ).fetchall()]
    conn.close()
    return jsonify(rules)


@app.route('/api/routing-rules', methods=['POST'])
def api_create_routing_rule():
    body = request.get_json()
    if not body.get('subfolder'):
        return jsonify({'error': 'subfolder required'}), 400
    conn = get_conn()
    with conn:
        cur = conn.execute(
            'INSERT INTO routing_rules (name_contains, extensions, subfolder, priority) VALUES (?, ?, ?, ?)',
            (body.get('name_contains', ''), body.get('extensions', ''),
             body['subfolder'], int(body.get('priority', 0)))
        )
        rid = cur.lastrowid
    conn.close()
    return jsonify({'id': rid}), 201


@app.route('/api/routing-rules/<int:rid>', methods=['PUT'])
def api_update_routing_rule(rid):
    body = request.get_json()
    conn = get_conn()
    with conn:
        conn.execute(
            'UPDATE routing_rules SET name_contains=?, extensions=?, subfolder=?, priority=? WHERE id=?',
            (body.get('name_contains', ''), body.get('extensions', ''),
             body['subfolder'], int(body.get('priority', 0)), rid)
        )
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/routing-rules/<int:rid>', methods=['DELETE'])
def api_delete_routing_rule(rid):
    conn = get_conn()
    with conn:
        conn.execute('DELETE FROM routing_rules WHERE id=?', (rid,))
    conn.close()
    return jsonify({'ok': True})


# ── Classify & download ───────────────────────────────────────────────────────

def _match_routing_rule(rules: list, filename: str) -> dict | None:
    ext        = Path(filename).suffix.lower()
    name_lower = filename.lower()
    for rule in rules:  # already sorted priority DESC
        name_ok = not rule['name_contains'] or rule['name_contains'].lower() in name_lower
        ext_ok  = True
        if rule['extensions']:
            allowed = [e.strip().lower() for e in rule['extensions'].split(',')]
            ext_ok  = ext in allowed
        if name_ok and ext_ok:
            return rule
    return None


@app.route('/api/gmail/message/<gmail_message_id>/classify', methods=['POST'])
def api_classify(gmail_message_id):
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated'}), 401

    conn = get_conn()
    row  = conn.execute(
        'SELECT from_address FROM gmail_messages WHERE gmail_message_id = ?',
        (gmail_message_id,)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Message not found — sync first'}), 404

    sender = _extract_email(row['from_address'] or '')

    conn = get_conn()
    contact_row = conn.execute('''
        SELECT c.id, c.name, c.folder_path, c.type
        FROM contacts c
        JOIN contact_emails ce ON ce.contact_id = c.id
        WHERE ce.email = ?
    ''', (sender,)).fetchone()

    if not contact_row:
        conn.close()
        return jsonify({'contact': None, 'sender': row['from_address'], 'suggestions': []})

    contact = dict(contact_row)
    rules   = [dict(r) for r in conn.execute(
        'SELECT * FROM routing_rules ORDER BY priority DESC, id'
    ).fetchall()]
    conn.close()

    from googleapiclient.discovery import build
    service = build('gmail', 'v1', credentials=get_credentials())
    msg     = service.users().messages().get(
        userId='me', id=gmail_message_id, format='full'
    ).execute()

    raw_atts: list = []

    def _walk(parts):
        for part in parts or []:
            if part.get('filename'):
                raw_atts.append({
                    'attachment_id': part.get('body', {}).get('attachmentId', ''),
                    'name':          part['filename'],
                    'mime_type':     part.get('mimeType', ''),
                    'size':          part.get('body', {}).get('size', 0),
                })
            _walk(part.get('parts', []))

    _walk(msg.get('payload', {}).get('parts', []))

    suggestions = []
    for att in raw_atts:
        rule      = _match_routing_rule(rules, att['name'])
        subfolder = rule['subfolder'] if rule else ''
        dest_dir  = Path(contact['folder_path'])
        if subfolder:
            dest_dir = dest_dir / subfolder
        suggestions.append({
            **att,
            'dest_path':    str(dest_dir / att['name']),
            'rule_matched': subfolder or None,
        })

    return jsonify({'contact': contact, 'sender': row['from_address'], 'suggestions': suggestions})


@app.route('/api/gmail/message/<gmail_message_id>/download', methods=['POST'])
def api_gmail_download(gmail_message_id):
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated'}), 401

    items = request.get_json()
    if not items:
        return jsonify({'error': 'No files specified'}), 400

    from googleapiclient.discovery import build
    import base64 as _b64
    service = build('gmail', 'v1', credentials=get_credentials())

    results = []
    for item in items:
        try:
            att_data = service.users().messages().attachments().get(
                userId='me', messageId=gmail_message_id, id=item['attachment_id']
            ).execute()
            data = _b64.urlsafe_b64decode(att_data['data'])
            dest = Path(item['dest_path'])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            results.append({'name': item['name'], 'path': str(dest), 'ok': True})
        except Exception as e:
            results.append({'name': item['name'], 'error': str(e), 'ok': False})

    return jsonify({'results': results})


if __name__ == '__main__':
    app.run(debug=True)
