import pickle

def load_payload(raw_bytes):
    # Vulnerable: pickle.loads on untrusted bytes — RCE.
    return pickle.loads(raw_bytes)


def deserialize_session(session_blob):
    return pickle.loads(session_blob)
