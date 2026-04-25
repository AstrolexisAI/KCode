# Positive fixture for inj-005-path-traversal.
# open() called on a path derived directly from a request argument
# without realpath/containment — `?file=../../etc/passwd` walks out
# of the data directory.
from flask import request

def read_data():
    with open(request.args.get("file")) as fh:
        return fh.read()
