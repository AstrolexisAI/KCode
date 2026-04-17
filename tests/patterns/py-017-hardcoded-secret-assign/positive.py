"""Positive fixture for py-017-hardcoded-secret-assign.

Long-lived credentials as source-code string literals leak
eventually (git history, docker images, pastebins, backups).
"""

# CONFIRMED: 32-char AWS-style secret key committed to source.
aws_secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# CONFIRMED: RSA private key excerpt committed to source.
private_key = "MIIEowIBAAKCAQEAx7JQ8xYlmqU9ZrLxM8yF7KZ"

# CONFIRMED: database password in plaintext.
database_password = "prod_admin_pw_2026_01_01"
