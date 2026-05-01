from template_engine import render_template
from mailer import send_email
import json
import sys

def send_from_payload(payload: dict) -> dict:
    subject, html_body = render_template(
        payload['template_id'],
        payload['data']
    )
    result = send_email(
        to=payload['to'],
        subject=subject,
        html_body=html_body,
        cc=payload.get('cc')
    )
    print(f"Envoye id={result['id']}")
    return result

if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'payload.json'
    with open(path) as f:
        payload = json.load(f)
    send_from_payload(payload)
