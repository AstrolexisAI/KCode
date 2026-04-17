"""Negative fixture for py-001-eval-exec.

No built-in call here. Methods named "evaluate" / "run_policy"
must not trip the word-boundary-anchored regex because they lack
the parenthesis-adjacent form the pattern is looking for.
"""

class Policy:
    def evaluate(self, rule: str) -> bool:
        return rule.startswith("allow:")

    def run_policy(self, data: dict) -> None:
        # Just a method — no built-in calls.
        print("policy applied", data)
