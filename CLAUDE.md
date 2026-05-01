# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pip install google-auth google-auth-oauthlib google-api-python-client jinja2 python-dotenv flask

# Send an email from a payload file (CLI mode)
python main.py payload.json

# Start the HTTP server (Flask mode)
python app.py
```

There is no test suite and no linter configured.

## Architecture

Two entry points, one shared core:

- **`main.py`** — CLI entry point. Reads a JSON payload, renders the template, sends the email.
- **`app.py`** — Flask HTTP server. Exposes `/auth`, `/oauth2callback`, `/send` (POST), `/status`. Delegates to the same `send_from_payload` from `main.py`.

Core modules:

- **`config.py`** — Single `Config` dataclass, instantiated as the `config` singleton. All paths and rate limits come from `.env` via this object. Everything else imports from it.
- **`auth.py`** — Gmail OAuth2 via `google-auth-oauthlib`. Credentials stored in `token.pickle` (path from `config.token_file`). `get_credentials()` auto-refreshes expired tokens. `build_auth_flow()` / `exchange_and_save()` are used by `app.py` for the web OAuth flow; the CLI flow is not yet wired (must run `app.py /auth` first, then switch to CLI).
- **`mailer.py`** — Builds a `MIMEMultipart('alternative')` message and calls `gmail.users().messages().send`. HTML-only (no plain-text part).
- **`template_engine.py`** — Jinja2 `Environment` with `autoescape` on HTML. Injects `now` (UTC datetime) as a global. Subject is extracted from a `{% set subject = "..." %}` block at the top of each template via `template.make_module()`.

## Templates

Located in `templates/`. Each `.html` file maps to a `template_id` in the payload. The subject **must** be declared as `{% set subject = "..." %}` at the top — it is extracted at render time, not passed in `data`.

| template_id      | Status  |
|------------------|---------|
| welcome          | Ready   |
| invoice          | Stub    |
| onboarding       | Stub    |
| notation_google  | Stub    |

## Required files (not committed)

| File               | Purpose                                      |
|--------------------|----------------------------------------------|
| `credentials.json` | Google Cloud OAuth 2.0 Desktop App client secret |
| `token.pickle`     | Saved OAuth token, created on first auth     |
| `.env`             | Overrides for `GMAIL_SENDER`, paths, limits  |

Gmail send limits: 500 emails/day (free), 2000/day (Workspace). Configurable via `RATE_LIMIT_DAY` and `RATE_LIMIT_SEC` env vars, but rate limiting is not yet enforced in code — the values are stored in `config` only.
