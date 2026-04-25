# Negative fixture for des-002-yaml-full-load.
# safe_load rejects custom tags, so attacker payloads can't reach
# Python object construction.
import yaml

def parse_config(text: str):
    return yaml.safe_load(text)
