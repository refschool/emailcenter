## EmailCenter

Sends transactional HTML emails via the Gmail API using Jinja2 templates.

### Setup

```
pip install google-auth google-auth-oauthlib google-api-python-client jinja2 python-dotenv
```

1. Create a project in Google Cloud Console
2. Enable the Gmail API
3. Download `credentials.json` (OAuth 2.0 Desktop App) into this folder
4. Copy `.env` and fill in your sender address

### Run

```
python main.py payload.json
```

On first run an OAuth browser window will open. The token is saved to `token.pickle` and reused automatically.

### Payload format

```json
{
  "template_id": "welcome",
  "to": "user@example.com",
  "data": {
    "first_name": "Alice",
    "plan": "Pro",
    "trial_days": 14,
    "cta_url": "https://app.example.com",
    "cta_label": "Démarrer maintenant",
    "recipient_email": "user@example.com"
  }
}
```

### Templates

| id               | Status  |
|------------------|---------|
| welcome          | Ready   |
| invoice          | Stub    |
| onboarding       | Stub    |
| notation_google  | Stub    |

Add a `{% set subject = "..." %}` at the top of each template — it is extracted automatically as the email subject.


Design plugin
/plugin install frontend-design@claude-plugins-official


run the program
python main.py payload.json

{"template_id":"welcome","to":"yvon.huynh@gmail.com","subject":"Bienvenue, {{ first_name }} !","attachments":[
  {"path":"attachments/CGU.pdf","filename":"CGU.pdf"},
  {"path":"attachments/Livret Accueil.pdf","filename":"Livret Accueil.pdf"},
  {"path":"attachments/Règlement-intérieur.pdf","filename":"Règlement-intérieur.pdf"}],
  "data":{"first_name":"Yvon"}}


    {"Content-Type": "application/json",  "Authorization": "Bearer super_secret_key_12345"}


    http://localhost:5000/api/webhook/payload 