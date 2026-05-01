# EmailCenter — Session Report
Date: 2026-04-21

## Project Overview

EmailCenter is a Python transactional email sender for Formapedia 2026.
It uses the Gmail API (OAuth2) to send HTML emails rendered from Jinja2 templates.
Entry point: `main.py` — reads a JSON payload and sends the email via Flask API.

---

## What Was Built / Rewritten

### `config.py`
- Added `load_dotenv()` so `.env` is actually loaded at startup
- Fixed default `templates_dir` to match the actual folder name
- Added `sender_name` and `sender_email` with real defaults

### `auth.py`
- **v1 (local):** Used `InstalledAppFlow.run_local_server()` — opens a browser on first run, saves `token.pickle`, silently refreshes forever after
- **v2 (web):** Switched to `google_auth_oauthlib.flow.Flow` for proper web OAuth redirect flow
- Auth functions: `get_credentials()`, `is_authenticated()`, `build_auth_flow()`, `exchange_and_save()`

### `mailer.py`
- Added `msg['From']` header using `config.sender_name` + `config.sender_email` via `formataddr()`
- Removed duplicate Gmail API build per call
- **Temporary detour:** Rewrote using SMTP + App Password when user asked about no-approval sending — reverted when user confirmed Gmail API is required

### `template_engine.py`
- Fixed `FileSystemLoader` path (`template` → `templates`)
- Replaced broken `{% now %}` Jinja2 tag (requires unpublished extension) with a `now` global injected at env creation: `env.globals['now'] = datetime.now(timezone.utc)`
- Fixed subject extraction: used `template.make_module(vars=data)` so template variables are bound when reading `{% set subject %}`
- Eliminated double template load (was loading same file twice)

### `template/welcome.html` → `templates/welcome.html`
- Fixed `{% now 'utc', '%d/%m/%Y' %}` → `{{ now.strftime('%d/%m/%Y') }}`
- Folder renamed from `template/` to `templates/` to match config

### `app.py` (new)
- Flask web server with 4 routes:
  - `GET /auth` — starts OAuth flow, redirects to Google
  - `GET /oauth2callback` — handles Google redirect, saves token
  - `POST /send` — sends email from JSON payload
  - `GET /status` — returns authentication status
- `OAUTHLIB_INSECURE_TRANSPORT=1` loaded from `.env` for local dev

### `payload.json` (new)
- Test payload targeting `yvon.huynh@gmail.com` with `welcome` template

### `.env`
- Added `OAUTHLIB_INSECURE_TRANSPORT=1`
- Fixed `TEMPLATES_DIR=templates` (was `template`)
- Added all config keys: rate limits, token file, credentials file

### `.gitignore` (new)
- Protects `.env`, `credentials.json`, `token.pickle` from being committed

---

## Errors Encountered & Fixed

| Error | Cause | Fix |
|---|---|---|
| `TemplateNotFound: welcome.html` | `FileSystemLoader('templates')` but folder was `template/` | Renamed folder to `templates/`, fixed `.env` `TEMPLATES_DIR` |
| `{% now %}` crash at render | Not a built-in Jinja2 filter | Injected `datetime.now()` as `env.globals['now']` |
| `UndefinedError` on subject | `template.module.subject` renders without context | Switched to `template.make_module(vars=data)` |
| `ModuleNotFoundError: google.oauth2` | Google auth libraries not installed | `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client` |
| `InsecureTransportError` | OAuth requires HTTPS, running on HTTP localhost | Added `OAUTHLIB_INSECURE_TRANSPORT=1` to `.env` |
| `InvalidGrantError: Missing code verifier` | New `Flow` instance in `/oauth2callback` lost the `code_verifier` generated in `/auth` | Stored original flow in `_flows` dict keyed by `state`, reused same instance in callback |
| `TemplateNotFound` after server restart | `.env` had `TEMPLATES_DIR=template` (singular) but folder is `templates` (plural) | Fixed `.env` value |

---

## How to Run

```bash
# Install dependencies
pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client jinja2 flask python-dotenv

# Start server
python app.py

# Authenticate once (browser opens)
http://localhost:5000/auth

# Send test email
curl -X POST http://localhost:5000/send -H "Content-Type: application/json" -d @payload.json

# Check status
http://localhost:5000/status
```

## Google Cloud Setup Required
1. Create a project in Google Cloud Console
2. Enable Gmail API
3. Create OAuth 2.0 credentials (Web Application type)
4. Add `http://localhost:5000/oauth2callback` as authorized redirect URI
5. Download `credentials.json` into project root

---

## File Structure

```
EmailCenter/
├── .env                  # secrets & config (never commit)
├── .gitignore
├── credentials.json      # from Google Cloud (never commit)
├── token.pickle          # saved after first auth (never commit)
├── app.py                # Flask web server
├── auth.py               # OAuth2 flow
├── config.py             # loads .env, exposes config object
├── mailer.py             # Gmail API send
├── main.py               # send_from_payload() entry point
├── payload.json          # test payload
├── template_engine.py    # Jinja2 renderer
└── templates/
    ├── welcome.html      # ready
    ├── invoice.html      # stub
    ├── onboarding.html   # stub
    └── notation_google.html  # stub
```
