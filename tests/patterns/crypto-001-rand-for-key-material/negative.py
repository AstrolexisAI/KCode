# Negative fixture for crypto-001-rand-for-key-material.
# secrets.token_hex is the right tool for security tokens; pattern
# must not flag it.
import secrets

def make_session_token() -> str:
    return secrets.token_hex(16)
