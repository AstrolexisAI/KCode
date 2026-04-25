# Positive fixture for crypto-009-ecb-mode.
# AES-ECB encrypts identical plaintext blocks identically, leaking
# structure (the Tux penguin example).
from Crypto.Cipher import AES

def encrypt(key: bytes, plaintext: bytes) -> bytes:
    cipher = AES.new(key, AES.MODE_ECB)
    return cipher.encrypt(plaintext)
