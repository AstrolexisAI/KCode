# Negative fixture for crypto-007-tls-verify-off.
# verify defaults to True; explicit verify=True with a custom CA bundle
# is also fine.
import requests

def fetch(url: str) -> str:
    return requests.get(url).text

def fetch_with_internal_ca(url: str, ca_bundle: str) -> str:
    return requests.get(url, verify=ca_bundle).text
