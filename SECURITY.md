# Security Policy

## Reporting a Vulnerability

**Do NOT file a public GitHub issue for security vulnerabilities.**

Email **contact@astrolexis.space** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

## Scope

### In Scope

- KCode CLI application and all bundled tools
- Permission system bypasses or escalation
- Command injection through tool arguments or user input
- Credential leakage (API keys, tokens)
- Local file system access outside of intended scope
- MCP server communication vulnerabilities
- SQLite database corruption or unauthorized access

### Out of Scope

- Vulnerabilities in third-party LLM providers (Anthropic, OpenAI, etc.)
- Issues in upstream dependencies (report those to the respective projects)
- Social engineering attacks
- Denial of service against local inference servers
- Issues requiring physical access to the machine

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgment | Within 72 hours |
| Initial assessment | Within 1 week |
| Fix development | Within 30 days for critical/high severity |
| Public disclosure | After fix is released, coordinated with reporter |

Credit is given to reporters unless they prefer to remain anonymous.

## Supported Versions

Only the latest release is actively supported with security patches.
