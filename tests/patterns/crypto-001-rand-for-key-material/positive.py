# Positive fixture for crypto-001-rand-for-key-material.
# random.randint produces predictable output; using it as a session
# token lets an attacker reconstruct the secret.
import random

def issue_session():
    raw = random.randint(0, 999_999_999)
    return raw  # session token
