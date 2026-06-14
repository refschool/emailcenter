## EmailCenter

EmailCenter envoie des emails HTML transactionnels via Gmail, avec un composeur web, des templates Jinja2, une synchronisation Gmail et des outils de recherche sur les fichiers et les contacts.

### Prerequis

- Python 3.10+
- `credentials.json` pour OAuth Gmail Desktop
- un premier passage OAuth pour generer `token.json`

### Installation

PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\pip.exe install google-auth google-auth-oauthlib google-api-python-client jinja2 python-dotenv flask requests
```

Batch:

```bat
python -m venv .venv
.venv\Scripts\pip.exe install google-auth google-auth-oauthlib google-api-python-client jinja2 python-dotenv flask requests
```

### Configuration

Le projet lit `.env` via `config.py`.

Variables utiles:

```env
GMAIL_CREDENTIALS_FILE=credentials.json
GMAIL_TOKEN_FILE=token.json
GMAIL_SENDER=yvon.huynh@gmail.com
GMAIL_SENDER_NAME=Yvon Huynh
TEMPLATES_DIR=templates
ATTACHMENTS_DIR=attachments
PAYLOADS_DIR=payloads
WEBHOOK_SECRET=...
RATE_LIMIT_DAY=500
RATE_LIMIT_SEC=0.5
GMAIL_SYNC_INTERVAL_HOURS=6
EMAILCENTER_ALLOWED_HOSTS=localhost,127.0.0.1,::1,emailcenter.local
OAUTHLIB_INSECURE_TRANSPORT=1
```

`OAUTHLIB_INSECURE_TRANSPORT=1` sert uniquement en local pour OAuth Gmail sans HTTPS.

### Lancement

PowerShell:

```powershell
.venv\Scripts\python.exe app.py
```

Batch:

```bat
start_emailcenter.bat
```

Le batch lance Flask en arrière-plan et écrit dans `logs\app.log`.

### OAuth Gmail

1. Créer un projet Google Cloud.
2. Activer Gmail API.
3. Créer un client OAuth 2.0 de type Desktop App.
4. Placer `credentials.json` à la racine du projet.
5. Ouvrir `http://localhost:5000/auth`.
6. Valider l'autorisation Google.

Le jeton est sauvegardé dans `token.json` et réutilisé automatiquement.
Si tu avais encore un ancien `token.pickle`, supprime-le puis relance `/auth` pour repartir proprement.
Si le refresh échoue ou que le token est révoqué, les routes Gmail renvoient `401` et il faut refaire `/auth`.

### Workflows

Compose web:

1. Ouvrir l'interface sur `http://localhost:5000/`.
2. Choisir un template.
3. Modifier le JSON payload et les champs destinataire / sujet.
4. Lancer la preview.
5. Optionnellement ouvrir le composer HTML.
6. Envoyer ou sauvegarder en brouillon.

CLI:

1. Copier un exemple depuis `payload_templates/` vers `payloads/` ou créer un fichier JSON.
2. Adapter `template_id`, `to` et `data`.
3. Lancer:

```powershell
.venv\Scripts\python.exe main.py payload.json
```

Exemple minimal:

```json
{
  "template_id": "welcome",
  "to": "user@example.com",
  "data": {
    "first_name": "Alice",
    "recipient_email": "user@example.com"
  }
}
```

Payloads:

- `GET /api/payloads` liste les payloads d'exemple.
- `GET /api/payloads/<template_id>` charge un payload d'exemple pour un template.
- `POST /api/webhook/payload` enregistre un payload JSON dans `payloads/` si le secret est fourni.

Gmail:

- `POST /api/gmail/sync` synchronise les messages Gmail.
- `GET /api/gmail/messages` affiche les messages de la vue Mail.
- `GET /api/gmail/message/<id>` charge le contenu d'un message.
- `POST /api/gmail/message/<id>/read` marque un message comme lu.
- `POST /api/gmail/message/<id>/classify` classe un message.
- `POST /api/gmail/message/<id>/download` télécharge les pieces jointes détectées.

Contacts et routage:

- `GET /api/contacts` et `POST /api/contacts`
- `PUT /api/contacts/<id>` et `DELETE /api/contacts/<id>`
- `POST /api/contacts/<id>/emails`
- `GET /api/routing-rules`
- `POST /api/routing-rules`
- `PUT /api/routing-rules/<id>`
- `DELETE /api/routing-rules/<id>`

Recherche et aperçu:

- `GET /api/recipients/suggest`
- `POST /api/compose/folder-suggest`
- `POST /api/preview`
- `GET /api/everything/search`
- `GET /api/file?path=...`

### Templates

Chaque template `templates/*.html` doit définir le sujet au debut:

```jinja2
{% set subject = "Sujet" %}
```

Les payloads d'exemple sont dans `payload_templates/`. `invoice.html` a ete retire car il etait vide.

### Verification locale

Il n'y a pas de suite de tests automatisee. Les verifications minimales utiles sont:

PowerShell:

```powershell
.venv\Scripts\python.exe -m py_compile app.py config.py template_engine.py main.py
```

### Limites et precautions

- Le serveur Flask ne doit pas etre expose publiquement sans durcissement supplementaire.
- Les routes POST sensibles exigent un `Host` et un `Origin` locaux compatibles, plus un token CSRF.
- Le secret de webhook doit rester hors du depot.
- Les pieces jointes issues du navigateur ne gardent pas toujours leur chemin source d'origine.
- La recherche Everything interroge `http://localhost:81/`; le service Everything doit tourner localement.
- La synchronisation Gmail et l'index SQL sont des etats locaux; un reset peut etre necessaire apres corruption ou migration.
