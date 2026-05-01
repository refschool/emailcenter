import base64
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from googleapiclient.discovery import build

from auth import get_credentials
from config import config


def send_email(to: str, subject: str, html_body: str,
               cc: list = None, attachments: list = None) -> dict:
    creds = get_credentials()
    service = build('gmail', 'v1', credentials=creds)

    if attachments:
        msg = MIMEMultipart('mixed')
        body = MIMEMultipart('alternative')
        body.attach(MIMEText(html_body, 'html'))
        msg.attach(body)
        for att in attachments:
            mime = att.get('mime_type', 'application/octet-stream')
            if '/' not in mime:
                mime = 'application/octet-stream'
            main_type, sub_type = mime.split('/', 1)
            with open(att['path'], 'rb') as f:
                part = MIMEBase(main_type, sub_type)
                part.set_payload(f.read())
            encoders.encode_base64(part)
            part.add_header('Content-Disposition', 'attachment', filename=att['filename'])
            msg.attach(part)
    else:
        msg = MIMEMultipart('alternative')
        msg.attach(MIMEText(html_body, 'html'))

    msg['From'] = formataddr((config.sender_name, config.sender_email))
    msg['To'] = to
    msg['Subject'] = subject
    if cc:
        msg['Cc'] = ', '.join(cc)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return service.users().messages().send(
        userId='me', body={'raw': raw}
    ).execute()
