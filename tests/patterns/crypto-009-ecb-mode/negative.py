# Negative fixture for crypto-009-ecb-mode.
# AES-GCM is an authenticated mode and the right default.
from Crypto.Cipher import AES
import os

def encrypt(key: bytes, plaintext: bytes) -> tuple[bytes, bytes, bytes]:
    nonce = os.urandom(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ct, tag = cipher.encrypt_and_digest(plaintext)
    return nonce, ct, tag
