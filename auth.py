import json
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google.auth.exceptions import RefreshError
from google_auth_oauthlib.flow import Flow
from config import config

SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
]

def get_credentials() -> Credentials | None:
    token_path = Path(config.token_file)
    creds = None

    if token_path.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        except (ValueError, json.JSONDecodeError, OSError):
            creds = None

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError:
            raise
        _save(creds)

    if creds and creds.valid:
        return creds
    return None

def is_authenticated() -> bool:
    try:
        creds = get_credentials()
    except RefreshError:
        return False
    return creds is not None and creds.valid

def build_auth_flow(redirect_uri: str) -> Flow:
    flow = Flow.from_client_secrets_file(
        config.credentials_file,
        scopes=SCOPES,
        redirect_uri=redirect_uri
    )
    return flow

def exchange_and_save(flow: Flow, authorization_response: str):
    flow.fetch_token(authorization_response=authorization_response)
    _save(flow.credentials)

def _save(creds: Credentials):
    token_path = Path(config.token_file)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding='utf-8')
