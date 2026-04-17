"""Positive fixture for py-009-pickle-untrusted.

pickle.loads on request/body/payload data is RCE — pickle's
__reduce__ hook executes arbitrary code on deserialize.
"""
import pickle

def restore(request):
    # CONFIRMED: request.body is attacker-controlled.
    return pickle.loads(request.body)
