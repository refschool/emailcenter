# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Commands

PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\pip.exe install google-auth google-auth-oauthlib google-api-python-client jinja2 python-dotenv flask requests
.venv\Scripts\python.exe app.py
.venv\Scripts\python.exe main.py payload.json
```

Batch:

```bat
start_emailcenter.bat
```

There is no dedicated automated test suite. Use `py_compile` and the live Flask UI for verification.

## Architecture

Two entry points share the same rendering and mail sending core:

- `main.py` is the CLI sender. It loads a JSON payload, renders the template, and sends the email.
- `app.py` is the Flask server. It serves the web UI and exposes the API used by the compose screen, Gmail sync, contacts, routing rules, Everything search, previews, and webhook ingestion.

Core modules:

- `config.py` centralizes environment-backed settings from `.env`.
- `auth.py` handles Gmail OAuth2 and token refresh.
- `mailer.py` builds the Gmail MIME message and sends it through the API.
- `template_engine.py` renders Jinja2 templates and extracts the subject from `{% set subject = "..." %}`.
- `database.py` owns SQLite access and migrations.
- `gmail_sync.py` synchronizes Gmail into the local database.
- `payload_watcher.py` manages the runtime `payloads/` directory.

## Current routes

Public / UI:

- `GET /` main web UI
- `GET /auth` start Gmail OAuth
- `GET /oauth2callback` OAuth callback
- `GET /api/status`
- `GET /api/config`

Compose / payloads:

- `GET /api/templates`
- `GET /api/payloads`
- `GET /api/payloads/<template_id>`
- `POST /api/webhook/payload`
- `POST /api/preview`
- `POST /api/compose/folder-suggest`
- `POST /api/compose/send`

Attachments / favorites:

- `GET /api/file`
- `GET /api/attachments/favorites`
- `POST /api/attachments/favorites/rebuild`

Gmail:

- `POST /api/gmail/sync`
- `GET /api/gmail/messages`
- `GET /api/gmail/message/<gmail_message_id>`
- `POST /api/gmail/message/<gmail_message_id>/read`
- `POST /api/gmail/message/<gmail_message_id>/classify`
- `POST /api/gmail/message/<gmail_message_id>/download`

Contacts / routing:

- `GET /api/recipients/suggest`
- `GET /api/contacts`
- `POST /api/contacts`
- `PUT /api/contacts/<cid>`
- `DELETE /api/contacts/<cid>`
- `POST /api/contacts/<cid>/emails`
- `DELETE /api/contact-emails/<eid>`
- `GET /api/routing-rules`
- `POST /api/routing-rules`
- `PUT /api/routing-rules/<rid>`
- `DELETE /api/routing-rules/<rid>`

Browse / search:

- `GET /api/browse`
- `GET /api/everything/search`

Mail utilities:

- `GET /api/composed`
- `POST /api/check_files`
- `GET /api/gmail/message/<gmail_message_id>/download`

## Templates

Templates live in `templates/`. Each `.html` file maps to a template id.

Important rules:

- The subject must be declared at the top with `{% set subject = "..." %}`.
- The preview endpoint renders the template with the payload `data` object.
- Example payloads live in `payload_templates/`; runtime payloads created by the app live in `payloads/`.
- `invoice.html` was removed because it was an empty stub.

## Security model

- Flask now runs with `debug=False` by default.
- Sensitive POST routes are guarded by a local-only `Host` check, an `Origin` check, and a CSRF token.
- The CSRF token is embedded in the root HTML and sent by the frontend with `X-CSRF-Token`.
- `WEBHOOK_SECRET` protects `POST /api/webhook/payload`.
- Keep `OAUTHLIB_INSECURE_TRANSPORT=1` only for localhost development.
- Gmail refresh failures surface as `401`; the fix is to re-run `/auth` and rebuild the JSON token.

## Required files

| File | Purpose |
|------|---------|
| `credentials.json` | Google Cloud OAuth 2.0 Desktop App client secret |
| `token.json` | Saved OAuth token, created on first auth |
| `.env` | Paths, sender identity, webhook secret, host allowlist, rate limits |

Legacy `token.pickle` files are no longer read. Delete the old file and re-run `/auth` to rebuild the token in JSON format.

## Known limits

- Gmail rate limiting values exist in config, but enforcement is not implemented.
- Everything search depends on the local Everything HTTP server on `http://localhost:81/`.
- Local file attachments do not always preserve original source path metadata in the browser.
- The app uses a local SQLite database; a corrupted state may require manual cleanup.
- This project has no formal test suite; verification is currently manual plus `py_compile`.
