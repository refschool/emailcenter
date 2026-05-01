# EmailCenter skill

You are helping with the EmailCenter project — a Flask + Gmail API transactional email service for Formapedia 2026.

## Stack
- Python, Flask, Jinja2, Gmail API (OAuth2), python-dotenv
- Entry: `app.py` (web) or `python main.py payload.json` (CLI)

## Key facts
- Auth is one-time: `token.pickle` persists and auto-refreshes. Only `/auth` again if token is deleted or revoked.
- `OAUTHLIB_INSECURE_TRANSPORT=1` in `.env` is required for localhost dev — remove on production with real HTTPS.
- Templates live in `templates/` — each must have `{% set subject = "..." %}` at the top for auto subject extraction.
- `_flows` dict in `app.py` preserves the OAuth flow instance between `/auth` and `/oauth2callback` to keep the `code_verifier` intact.
- Never commit `.env`, `credentials.json`, or `token.pickle`.

## Routes
- `GET /auth` — start OAuth
- `GET /oauth2callback` — Google redirect handler
- `POST /send` — send email (JSON payload)
- `GET /status` — check auth

## Payload format
```json
{
  "template_id": "welcome",
  "to": "user@example.com",
  "data": {
    "first_name": "Alice",
    "plan": "Pro",
    "trial_days": 14,
    "cta_url": "https://formapedia.com",
    "cta_label": "Accéder à mon compte",
    "recipient_email": "user@example.com"
  }
}
```

## Common issues
- `TemplateNotFound` → check `TEMPLATES_DIR` in `.env` matches actual folder name (`templates`)
- `InsecureTransportError` → `OAUTHLIB_INSECURE_TRANSPORT=1` missing from `.env`
- `InvalidGrantError: Missing code verifier` → flow instance not preserved between `/auth` and `/oauth2callback`
- `ModuleNotFoundError` → run `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client jinja2 flask python-dotenv`
