from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import Flow
from config import config
import pickle
import os

SCOPES = ['https://www.googleapis.com/auth/gmail.send']

def get_credentials() -> Credentials:
    creds = None
    if os.path.exists(config.token_file):
        with open(config.token_file, 'rb') as f:
            creds = pickle.load(f)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _save(creds)

    return creds

def is_authenticated() -> bool:
    creds = get_credentials()
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
    with open(config.token_file, 'wb') as f:
        pickle.dump(creds, f)
