import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()

@dataclass
class Config:
    # Gmail API
    credentials_file: str = os.getenv('GMAIL_CREDENTIALS_FILE', 'credentials.json')
    token_file: str = os.getenv('GMAIL_TOKEN_FILE', 'token.json')
    
    # Expéditeur
    sender_email: str = os.getenv('GMAIL_SENDER', 'yvon.huynh@gmail.com')
    sender_name: str = os.getenv('GMAIL_SENDER_NAME', 'Yvon Huynh')
    
    # Templates
    templates_dir: str = os.getenv('TEMPLATES_DIR', 'templates')
    
    # Attachments
    attachments_dir: str = os.getenv('ATTACHMENTS_DIR', 'attachments')
    attachment_favorites_file: str = os.getenv('ATTACHMENT_FAVORITES_FILE', 'attachments/favorites.txt')

    # Webhook
    payloads_dir: str    = os.getenv('PAYLOADS_DIR', 'payloads')
    webhook_secret: str  = os.getenv('WEBHOOK_SECRET', '')

    # Limites Gmail (500/jour gratuit, 2000/jour Workspace)
    rate_limit_per_day: int = int(os.getenv('RATE_LIMIT_DAY', 500))
    rate_limit_per_second: float = float(os.getenv('RATE_LIMIT_SEC', 0.5))

    # Sync interval in hours (auto-sync on page load if exceeded)
    gmail_sync_interval_hours: int = int(os.getenv('GMAIL_SYNC_INTERVAL_HOURS', 6))

config = Config()
