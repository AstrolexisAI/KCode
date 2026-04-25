# Negative fixture for inj-005-path-traversal.
# Resolve to absolute path, verify it stays within an allowed root
# before opening.
import os
from flask import request

DATA_ROOT = os.path.realpath("/srv/data")

def read_data():
    name = request.args.get("file") or ""
    candidate = os.path.realpath(os.path.join(DATA_ROOT, name))
    if not candidate.startswith(DATA_ROOT + os.sep):
        return "forbidden", 403
    with open(candidate) as fh:
        return fh.read()
