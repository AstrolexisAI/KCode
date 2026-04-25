# Negative fixture for des-001-pickle-loads.
# JSON for untrusted input — pickle never touches user-controllable
# bytes.
import json

def load_session(cookie_bytes: bytes):
    return json.loads(cookie_bytes.decode())
