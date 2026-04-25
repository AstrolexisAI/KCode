# Positive fixture for des-001-pickle-loads.
# pickle.loads on attacker-controlled bytes is full RCE — `__reduce__`
# payload runs arbitrary code at deserialize time.
import pickle

def load_session(cookie_bytes: bytes):
    return pickle.loads(cookie_bytes)
