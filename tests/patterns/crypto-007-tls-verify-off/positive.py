# Positive fixture for crypto-007-tls-verify-off.
# verify=False disables TLS cert validation — any MITM can intercept.
import requests

def fetch(url: str) -> str:
    return requests.get(url, verify=False).text
