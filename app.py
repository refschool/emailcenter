import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, redirect, request, jsonify, send_from_directory, send_file

from auth import build_auth_flow, exchange_and_save, is_authenticated
from config import config
from database import get_conn, apply_migrations
from template_engine import render_template
from mailer import send_email
import gmail_sync

app = Flask(__name__, static_folder='static', static_url_path='')

REDIRECT_URI = 'http://localhost:5000/oauth2callback'
_flows: dict = {}

apply_migrations()


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


@app.route('/api/payloads/<template_id>')
def api_payload(template_id):
    path = Path('payloads') / f'{template_id}.json'
    if not path.exists():
        return jsonify({})
    return jsonify(json.loads(path.read_text(encoding='utf-8')))


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


if __name__ == '__main__':
    app.run(debug=True)
