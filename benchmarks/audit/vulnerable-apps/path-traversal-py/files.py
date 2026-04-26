from flask import Flask, request

app = Flask(__name__)

@app.route("/file")
def serve_file():
    # Vulnerable: open() with raw user-controlled name (no validation).
    filename = request.args.get("name")
    with open(filename, "rb") as f:
        return f.read()
