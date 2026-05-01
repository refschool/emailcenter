import base64
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from googleapiclient.discovery import build
from auth import get_credentials
from config import config

def send_email(to: str, subject: str, html_body: str, cc: list = None) -> dict:
    creds = get_credentials()
    service = build('gmail', 'v1', credentials=creds)

    msg = MIMEMultipart('alternative')
    msg['From'] = formataddr((config.sender_name, config.sender_email))
    msg['To'] = to
    msg['Subject'] = subject
    if cc:
        msg['Cc'] = ', '.join(cc)

    msg.attach(MIMEText(html_body, 'html'))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = service.users().messages().send(
        userId='me',
        body={'raw': raw}
    ).execute()

    return result
