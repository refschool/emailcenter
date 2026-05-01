import os
from dotenv import load_dotenv
load_dotenv()

from flask import Flask, redirect, request, url_for, jsonify
from auth import build_auth_flow, exchange_and_save, is_authenticated
from main import send_from_payload

app = Flask(__name__)

REDIRECT_URI = 'http://localhost:5000/oauth2callback'

_flows = {}  # state → flow, preserves code_verifier between requests

@app.route('/auth')
def auth():
    flow = build_auth_flow(REDIRECT_URI)
    auth_url, state = flow.authorization_url(prompt='consent')
    _flows[state] = flow
    return redirect(auth_url)

@app.route('/oauth2callback')
def oauth2callback():
    state = request.args.get('state')
    flow = _flows.pop(state, None)
    if not flow:
        return 'Invalid state — retournez sur /auth', 400
    exchange_and_save(flow, request.url)
    return 'Authentification réussie. Vous pouvez fermer cet onglet.'

@app.route('/send', methods=['POST'])
def send():
    if not is_authenticated():
        return jsonify({'error': 'Not authenticated. Visit /auth first.'}), 401
    payload = request.get_json()
    result = send_from_payload(payload)
    return jsonify(result)

@app.route('/status')
def status():
    return jsonify({'authenticated': is_authenticated()})

if __name__ == '__main__':
    app.run(debug=True)
