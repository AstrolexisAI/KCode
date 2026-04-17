"""Negative fixture for py-017-hardcoded-secret-assign.

Credentials read from environment or a secrets manager at
runtime don't match the literal-assignment pattern.
"""
import os

def get_aws_secret() -> str:
    return os.environ["AWS_SECRET_ACCESS_KEY"]

def get_db_password() -> str:
    return os.environ.get("DATABASE_PASSWORD", "")
