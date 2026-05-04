import json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from auth import get_credentials
from database import get_conn

_MAILBOXES = {
    'INBOX': 'INBOX',
    'SENT':  'SENT',
    'DRAFT': 'DRAFT',
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_headers(headers: list) -> dict:
    out = {}
    for h in headers:
        name = h['name'].lower()
        if name in ('from', 'to', 'cc', 'subject', 'date'):
            out[name] = h['value']
    return out


def _to_iso(date_str: str) -> str:
    try:
        return parsedate_to_datetime(date_str).astimezone(timezone.utc).isoformat()
    except Exception:
        return date_str


def _label_to_mailbox(label_ids: list) -> str | None:
    if 'INBOX' in label_ids: return 'INBOX'
    if 'SENT'  in label_ids: return 'SENT'
    if 'DRAFT' in label_ids: return 'DRAFT'
    return None


def _fetch_and_insert(service, conn, mid: str, mailbox: str) -> None:
    msg = service.users().messages().get(
        userId='me', id=mid, format='metadata',
        metadataHeaders=['From', 'To', 'Cc', 'Subject', 'Date']
    ).execute()
    h = _parse_headers(msg.get('payload', {}).get('headers', []))
    conn.execute("""
        INSERT OR IGNORE INTO gmail_messages
            (gmail_message_id, thread_id, mailbox,
             from_address, to_address, cc_address,
             subject, snippet, labels, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        mid,
        msg.get('threadId'),
        mailbox,
        h.get('from'), h.get('to'), h.get('cc'),
        h.get('subject'),
        msg.get('snippet', ''),
        json.dumps(msg.get('labelIds', [])),
        _to_iso(h.get('date', '')),
    ))


# ── Full sync (first run) ─────────────────────────────────────────────────────

def _full_sync(service, conn, max_per_mailbox: int = 100) -> int:
    total = 0
    for mailbox, label in _MAILBOXES.items():
        resp = service.users().messages().list(
            userId='me', labelIds=[label], maxResults=max_per_mailbox
        ).execute()
        for ref in resp.get('messages', []):
            mid = ref['id']
            if conn.execute(
                'SELECT 1 FROM gmail_messages WHERE gmail_message_id = ?', (mid,)
            ).fetchone():
                continue
            _fetch_and_insert(service, conn, mid, mailbox)
            total += 1
    return total


# ── Incremental sync (subsequent runs via History API) ────────────────────────

def _incremental_sync(service, conn, history_id: str) -> int:
    total = 0
    page_token = None

    while True:
        kwargs = dict(
            userId='me',
            startHistoryId=history_id,
            historyTypes=['messageAdded', 'messageDeleted'],
        )
        if page_token:
            kwargs['pageToken'] = page_token

        resp = service.users().history().list(**kwargs).execute()

        for record in resp.get('history', []):
            for added in record.get('messagesAdded', []):
                msg_ref = added.get('message', {})
                mid     = msg_ref.get('id')
                if not mid:
                    continue
                if conn.execute(
                    'SELECT 1 FROM gmail_messages WHERE gmail_message_id = ?', (mid,)
                ).fetchone():
                    continue
                label_ids = msg_ref.get('labelIds', [])
                mailbox   = _label_to_mailbox(label_ids)
                if not mailbox:
                    continue
                _fetch_and_insert(service, conn, mid, mailbox)
                total += 1

            for deleted in record.get('messagesDeleted', []):
                mid = deleted.get('message', {}).get('id')
                if mid:
                    conn.execute(
                        'DELETE FROM gmail_messages WHERE gmail_message_id = ?', (mid,)
                    )

        page_token = resp.get('nextPageToken')
        if not page_token:
            break

    return total


# ── Public API ────────────────────────────────────────────────────────────────

def reconcile_sync(per_mailbox: int = 50) -> dict:
    """Compare top-N Gmail IDs per mailbox with local DB — no wipe."""
    creds   = get_credentials()
    service = build('gmail', 'v1', credentials=creds)
    conn    = get_conn()

    added = removed = 0

    for mailbox, label in _MAILBOXES.items():
        resp = service.users().messages().list(
            userId='me', labelIds=[label], maxResults=per_mailbox
        ).execute()
        gmail_ids = [ref['id'] for ref in resp.get('messages', [])]
        if not gmail_ids:
            continue

        gmail_id_set  = set(gmail_ids)
        placeholders  = ','.join('?' * len(gmail_ids))

        # Find the oldest date within this fetched window (using already-local rows)
        local_known = conn.execute(
            f'SELECT gmail_message_id, date FROM gmail_messages'
            f' WHERE mailbox = ? AND gmail_message_id IN ({placeholders})',
            [mailbox] + gmail_ids
        ).fetchall()

        local_id_set = {r['gmail_message_id'] for r in local_known}

        if local_known:
            dates = [r['date'] for r in local_known if r['date']]
            if dates:
                window_floor = min(dates)
                cur = conn.execute(
                    f'DELETE FROM gmail_messages'
                    f' WHERE mailbox = ? AND date >= ? AND gmail_message_id NOT IN ({placeholders})',
                    [mailbox, window_floor] + gmail_ids
                )
                removed += cur.rowcount

        # Insert any Gmail ID not yet in local DB
        for mid in gmail_ids:
            if mid not in local_id_set:
                _fetch_and_insert(service, conn, mid, mailbox)
                added += 1

    profile        = service.users().getProfile(userId='me').execute()
    new_history_id = str(profile.get('historyId', ''))
    conn.execute(
        'UPDATE sync_state SET last_synced_at = ?, history_id = ? WHERE id = 1',
        (datetime.now(timezone.utc).isoformat(), new_history_id)
    )
    conn.commit()
    conn.close()
    return {'added': added, 'removed': removed}


def full_reset_sync(max_per_mailbox: int = 200) -> int:
    """Wipe local cache and re-fetch from Gmail. Picks up deletions."""
    creds   = get_credentials()
    service = build('gmail', 'v1', credentials=creds)
    conn    = get_conn()

    conn.execute('DELETE FROM gmail_messages')
    conn.execute('UPDATE sync_state SET history_id = NULL WHERE id = 1')
    conn.commit()

    total = _full_sync(service, conn, max_per_mailbox)

    profile        = service.users().getProfile(userId='me').execute()
    new_history_id = str(profile.get('historyId', ''))
    conn.execute(
        'UPDATE sync_state SET last_synced_at = ?, history_id = ? WHERE id = 1',
        (datetime.now(timezone.utc).isoformat(), new_history_id)
    )
    conn.commit()
    conn.close()
    return total


def sync(max_per_mailbox: int = 100) -> int:
    creds   = get_credentials()
    service = build('gmail', 'v1', credentials=creds)
    conn    = get_conn()

    row = conn.execute(
        'SELECT history_id FROM sync_state WHERE id = 1'
    ).fetchone()
    stored_history_id = row['history_id'] if row else None

    if stored_history_id:
        try:
            total = _incremental_sync(service, conn, stored_history_id)
        except HttpError as e:
            if e.resp.status == 404:
                # historyId expired (> ~30 days) — fall back to full sync
                conn.execute(
                    'UPDATE sync_state SET history_id = NULL WHERE id = 1'
                )
                total = _full_sync(service, conn, max_per_mailbox)
            else:
                conn.close()
                raise
    else:
        total = _full_sync(service, conn, max_per_mailbox)

    # Persist the latest historyId so next sync is incremental
    profile        = service.users().getProfile(userId='me').execute()
    new_history_id = str(profile.get('historyId', ''))

    conn.execute(
        'UPDATE sync_state SET last_synced_at = ?, history_id = ? WHERE id = 1',
        (datetime.now(timezone.utc).isoformat(), new_history_id)
    )
    conn.commit()
    conn.close()
    return total


def get_state() -> dict:
    conn = get_conn()
    row  = conn.execute(
        'SELECT last_synced_at, history_id FROM sync_state WHERE id = 1'
    ).fetchone()
    conn.close()
    return dict(row) if row else {}
