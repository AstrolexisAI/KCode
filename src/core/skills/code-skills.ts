// KCode - Code analysis skills

import type { SkillDefinition } from "../builtin-skills";

export const codeSkills: SkillDefinition[] = [
  {
    name: "explain",
    description: "Explain code or concept",
    aliases: ["what"],
    args: ["code or file to explain"],
    template: `Explain the following in clear, concise terms: {{args}}`,
  },
  {
    name: "find-bug",
    description: "Find bugs in code",
    aliases: ["bug", "debug"],
    args: ["file or description"],
    template: `Analyze the following for potential bugs, edge cases, and issues: {{args}}. Look for: null/undefined errors, off-by-one errors, race conditions, resource leaks, missing error handling, security issues.`,
  },
  {
    name: "doc",
    description: "Generate documentation",
    aliases: ["document"],
    args: ["file or function"],
    template: `Generate or update documentation for: {{args}}. Follow the project's existing documentation style. Include usage examples where appropriate.`,
  },
  {
    name: "type",
    description: "Add or fix types",
    aliases: ["types"],
    args: ["file or function"],
    template: `Review and improve TypeScript types for: {{args}}. Add missing type annotations, fix any type errors, and ensure type safety. Use strict types, avoid 'any'.`,
  },
  {
    name: "depgraph",
    description: "Show import/export dependency tree for a file",
    aliases: ["deps-tree", "imports"],
    args: ["file path"],
    template: `__builtin_depgraph__`,
  },
  {
    name: "outline",
    description: "Show file structure (functions, classes, exports)",
    aliases: ["symbols", "structure"],
    args: ["file path"],
    template: `__builtin_outline__`,
  },
  {
    name: "security",
    description: "Security audit",
    aliases: ["audit"],
    args: ["file or scope"],
    template: `Perform a security audit. {{#if args}}Focus on: {{args}}{{/if}}{{^if args}}Scan the project for common security vulnerabilities.{{/if}} Check for: injection vulnerabilities, hardcoded secrets, insecure dependencies, missing input validation, authentication issues.`,
  },
  {
    name: "security-review",
    description: "Scan code for security vulnerabilities",
    aliases: ["sec", "vuln"],
    args: ["file or directory path"],
    template: `Perform a thorough security review of the specified code.

Target: {{args}}

1. Read the target file(s) — if a directory, scan all source files.
2. Check for OWASP Top 10 vulnerabilities:
   - Injection (SQL, command, LDAP, XSS)
   - Broken authentication / session management
   - Sensitive data exposure (hardcoded secrets, API keys, passwords)
   - XXE (XML External Entities)
   - Broken access control
   - Security misconfiguration
   - Insecure deserialization
   - Using components with known vulnerabilities
   - Insufficient logging & monitoring
3. Check for language-specific issues:
   - TypeScript/JS: eval(), innerHTML, dangerouslySetInnerHTML, prototype pollution
   - Python: pickle, exec, shell=True, format string injection
   - Go: sql.Query with string concat, unsafe pointer use
4. Report findings with severity (CRITICAL/HIGH/MEDIUM/LOW), file:line, and fix recommendation.
5. If no issues found, confirm the code is clean.

Be thorough but avoid false positives. Only report real risks.`,
  },
];
