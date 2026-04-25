# Negative fixture for py-021-torch-load-untrusted.
# Hardcoded internal path + weights_only=True (PyTorch 2.6+ default,
# but still recommended to be explicit) → no RCE surface.
import torch

def predict():
    model = torch.load("/srv/models/sentiment.pt", weights_only=True)
    return model.predict(...)
