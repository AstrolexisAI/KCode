# Positive fixture for des-002-yaml-full-load.
# yaml.load (without SafeLoader) honors `!!python/object/apply:os.system`
# — RCE on parsing.
import yaml

def parse_config(text: str):
    return yaml.load(text)
