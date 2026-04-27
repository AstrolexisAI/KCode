// KCode - SQL Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const SQL_PATTERNS: BugPattern[] = [
  {
    id: "sql-001-grant-all",
    title: "GRANT ALL PRIVILEGES (over-permissioned)",
    severity: "high",
    languages: ["sql"],
    regex: /GRANT\s+ALL\s+PRIVILEGES/gi,
    explanation:
      "Granting ALL PRIVILEGES violates least-privilege principle. Grant only needed permissions.",
    verify_prompt:
      "Is this a setup/migration script for a dedicated service account, or a shared account? If overly broad, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is a local development/test setup script (not used in production)\n" +
      "2. The GRANT is for a dedicated service account with limited scope on a specific database\n" +
      "3. This is a temporary migration script with a corresponding REVOKE\n" +
      "4. The user is a superadmin/DBA account intended to have full access\n" +
      "Only respond CONFIRMED if this grants ALL PRIVILEGES to a shared or application account in production.",
    cwe: "CWE-250",
    fix_template: "GRANT SELECT, INSERT, UPDATE ON specific_table TO user;",
  },
  {
    id: "sql-002-plaintext-password",
    title: "Plaintext password in SQL",
    severity: "critical",
    languages: ["sql"],
    regex: /(?:PASSWORD|IDENTIFIED BY)\s+['"][^'"]+['"]/gi,
    explanation: "Plaintext passwords in SQL scripts are exposed to anyone with repo access.",
    verify_prompt:
      "Is this a real password or a placeholder like 'changeme'? If real, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The password is a placeholder ('changeme', 'xxx', 'password', 'TODO', 'REPLACE_ME', 'secret')\n" +
      "2. This is in test, example, seed data, or documentation code\n" +
      "3. The password is loaded from an environment variable or secrets manager at runtime\n" +
      "4. This is a local development setup script not intended for production\n" +
      "Only respond CONFIRMED if a real production password is hardcoded in the SQL script.",
    cwe: "CWE-798",
    fix_template: "Use environment variables or secrets manager for credentials.",
  },
];
