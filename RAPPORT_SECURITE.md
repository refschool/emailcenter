# Rapport de sécurité — EmailCenter

Date : 2026-05-28
Périmètre : analyse statique du code (Flask + SQLite + frontend SPA).

Contexte transverse : le serveur écoute en HTTP sans **aucune protection CSRF**. Cela
signifie qu'une page web malveillante ouverte dans le navigateur de l'utilisateur peut
envoyer des requêtes (`POST`/`GET`) vers `http://localhost:5000` et déclencher les routes
ci-dessous à l'insu de l'utilisateur. C'est ce qui fait passer plusieurs failles de
« risque théorique en local » à **réellement exploitable**.

| Criticité | Faille | Explication | Remède | Fichiers impactés |
|-----------|--------|-------------|--------|-------------------|
| **Critique** | Écriture / écrasement de fichier arbitraire | La route `/api/gmail/message/<id>/download` prend `dest_path` directement depuis le JSON client, crée l'arborescence (`mkdir parents`) et écrit les octets (`write_bytes`). Elle force même un fichier existant en écriture (`chmod`) avant de l'écraser. Un attaquant peut écrire/écraser n'importe quel fichier (ex. dossier Démarrage Windows, script `.bat`, fichier système). | Restreindre `dest_path` à une liste blanche de dossiers racines autorisés (dossiers des contacts, `attachments/`) ; résoudre le chemin (`resolve()`) et vérifier qu'il est bien sous un dossier autorisé ; ne jamais `chmod` puis écraser sans confirmation. | `app.py` (≈818-848), `static/js/app.js` (`_confirmDownload`) |
| **Critique** | Lecture de fichier arbitraire | La route `/api/file` sert **n'importe quel chemin absolu** sans le restreindre à un dossier racine et sans authentification. Permet d'exfiltrer `token.json`, `.env`, `credentials.json`, etc. | Confiner les chemins servis à des dossiers autorisés (vérifier que le chemin résolu est sous une racine connue) ; renvoyer 403 sinon ; ajouter une vérification d'origine. | `app.py` (≈75-83), `static/js/app.js` (`previewAttachment`) |
| **Critique** | `debug=True` en exécution | Le serveur démarre avec le débogueur Werkzeug et le rechargement auto activés. Couplé aux failles de lecture/écriture, cela ouvre un risque d'exécution de code à distance si le serveur devient accessible. | Passer à `debug=False` ; n'activer le debug que via une variable d'environnement explicite en dev local. | `app.py` (≈852), `start_emailcenter.bat` |
| **Élevée** | Absence de protection CSRF | Toutes les routes `POST` (envoi d'email, écriture de fichiers, contacts, règles) sont déclenchables par une page web tierce visitée par l'utilisateur, car aucune vérification d'origine n'est faite et l'authentification Gmail est déjà présente localement. | Binder le serveur sur `127.0.0.1` uniquement ; vérifier l'en-tête `Origin`/`Host` sur chaque `POST` (anti DNS-rebinding) ; idéalement un jeton anti-CSRF. | `app.py` (toutes les routes `POST`) |
| **Élevée** | Énumération complète du système de fichiers | La route `/api/browse` liste tous les lecteurs et répertoires de la machine, sans authentification ni vérification d'origine. Fournit la cartographie facilitant les failles de lecture/écriture. | Restreindre la navigation à des racines autorisées ; ajouter une vérification d'origine ; envisager une authentification locale. | `app.py` (≈511-543), `static/js/app.js` (`_fpBrowseTo`) |
| **Moyenne** | Injection de template (SSTI) sur le sujet | `_resolve_subject` rend le champ `subject` fourni par le client via `Environment().from_string(raw).render(**data)`. Évaluation de template sur entrée contrôlée par le client. Risque limité car mono-utilisateur local, mais réel si l'entrée devient non fiable (ex. via le webhook). | Ne pas évaluer de Jinja sur le sujet brut, ou utiliser un rendu strict en liste blanche de variables ; échapper/limiter les expressions. | `app.py` (≈165-173, `/api/preview` et `/api/compose/send`) |
| **Moyenne** | Webhook potentiellement ouvert | `/api/webhook/payload` n'est protégé que si `WEBHOOK_SECRET` est défini. Si la variable est vide, l'endpoint accepte n'importe quel payload (écrit un fichier JSON dans `payloads/`). | Rendre le secret obligatoire (refuser le démarrage ou la route si absent) ; comparer en temps constant. | `app.py` (≈124-145), `config.py` (`webhook_secret`) |
| **Faible** | Token OAuth stocké via `pickle` | L'ancien `token.pickle` exposait un risque de désérialisation de code si le fichier était corrompu. | Stocker le token en JSON avec `to_json()` / `from_authorized_user_file()` et supprimer l'ancien fichier avant réauthentification. | `auth.py` (`_save`, `get_credentials`) |

## Notes complémentaires (robustesse, sécurité-adjacent)

| Criticité | Point | Explication | Remède | Fichiers impactés |
|-----------|-------|-------------|--------|-------------------|
| **Faible** | `RefreshError` non gérée → 500 | `get_credentials()` peut lever `RefreshError` lors du rafraîchissement ; `is_authenticated()` l'appelle, et plusieurs routes ne l'encadrent pas. Renvoie un 500 au lieu d'un 401 propre quand le token est révoqué. | Encapsuler le refresh dans un try/except et renvoyer un statut « non authentifié » plutôt que de propager l'exception. | `auth.py` (≈19-27), `app.py` (`/api/status`, `/api/compose/send`) |
| **Faible** | Migration non atomique vis-à-vis du suivi | `executescript()` commit implicitement avant l'`INSERT INTO _migrations`. Un crash entre les deux laisse une migration appliquée mais non enregistrée ; au redémarrage, les `ALTER TABLE ADD COLUMN` (002/004) échouent (« duplicate column »). | Rendre les migrations idempotentes ou enregistrer l'application dans la même transaction ; gérer le cas colonne déjà existante. | `database.py` (≈27-33), `migrations/002_*.sql`, `migrations/004_*.sql` |
| **Info** | Pièces jointes uploadées jamais purgées | Les fichiers uploadés sont stockés sous UUID dans `attachments/` et jamais supprimés, même après envoi ou abandon d'un brouillon. | Nettoyer les fichiers orphelins (tâche planifiée ou suppression à l'envoi/abandon). | `app.py` (`/api/compose/send`), `attachments/` |

## Recommandation de priorisation

1. `debug=False` + bind `127.0.0.1` + vérification d'`Origin` sur les `POST` (corrige le vecteur CSRF qui amplifie tout le reste).
2. Sandboxer les chemins de `/api/file` et de la route `download` à des racines autorisées.
3. Restreindre `/api/browse`.
4. Rendre le secret webhook obligatoire ; migrer le stockage du token hors `pickle` vers JSON.
