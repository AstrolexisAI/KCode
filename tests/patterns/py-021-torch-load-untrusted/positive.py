# Positive fixture for py-021-torch-load-untrusted.
# torch.load on a user-supplied path is full RCE — pickle's __reduce__
# runs at load time. Same applies to joblib.load / cloudpickle.
import torch
from flask import request

def predict():
    model_path = request.args.get("model")
    model = torch.load(model_path)
    return model.predict(...)
