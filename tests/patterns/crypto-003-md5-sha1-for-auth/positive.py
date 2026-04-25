# Positive fixture for crypto-003-md5-sha1-for-auth.
# MD5 for password storage is broken — fast hashes + collisions
# undermine both confidentiality and integrity guarantees.
import hashlib

def store_password(plain: str) -> str:
    return hashlib.md5(plain.encode()).hexdigest()
