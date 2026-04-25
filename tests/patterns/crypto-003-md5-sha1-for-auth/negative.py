# Negative fixture for crypto-003-md5-sha1-for-auth.
# SHA-256 is acceptable for non-password hashing; bcrypt for passwords.
import hashlib
import bcrypt

def fingerprint(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()

def store_password(plain: str) -> bytes:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt())
