import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()

@dataclass
class Config:
    # Gmail API
    credentials_file: str = os.getenv('GMAIL_CREDENTIALS_FILE', 'credentials.json')
    token_file: str = os.getenv('GMAIL_TOKEN_FILE', 'token.pickle')
    
    # Expéditeur
    sender_email: str = os.getenv('GMAIL_SENDER', 'yvon.huynh@gmail.com')
    sender_name: str = os.getenv('GMAIL_SENDER_NAME', 'Yvon Huynh')
    
    # Templates
    templates_dir: str = os.getenv('TEMPLATES_DIR', 'templates')
    
    # Limites Gmail (500/jour gratuit, 2000/jour Workspace)
    rate_limit_per_day: int = int(os.getenv('RATE_LIMIT_DAY', 500))
    rate_limit_per_second: float = float(os.getenv('RATE_LIMIT_SEC', 0.5))

config = Config()