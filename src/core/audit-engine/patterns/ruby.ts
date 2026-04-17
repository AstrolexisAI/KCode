// KCode - RUBY Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const RUBY_PATTERNS: BugPattern[] = [
  {
    id: "rb-001-eval",
    title: "eval/send with dynamic input",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:eval|send|public_send|instance_eval|class_eval)\s*\(\s*(?:params|request|input)/g,
    explanation: "eval/send with user input enables arbitrary code execution.",
    verify_prompt: "Is the argument from user input? If internal/constant, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template: "Use a whitelist: ALLOWED_METHODS.include?(method_name) && obj.public_send(method_name)",
  },
  {
    id: "rb-002-sql-injection",
    title: "SQL with string interpolation",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:where|find_by_sql|execute|select)\s*\(\s*"/g,
    explanation: "ActiveRecord/SQL with string interpolation is vulnerable to injection.",
    verify_prompt: "Is user input interpolated via #{}? If using ? placeholders, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "User.where('email = ?', params[:email]) instead of string interpolation.",
  },
  {
    id: "rb-003-yaml-unsafe",
    title: "YAML.load with untrusted input",
    severity: "critical",
    languages: ["ruby"],
    regex: /\bYAML\.load\s*\(/g,
    explanation: "YAML.load in Ruby can execute arbitrary code. Use YAML.safe_load instead.",
    verify_prompt: "Is the YAML from untrusted source? If from internal config file, respond FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template: "YAML.safe_load(data, permitted_classes: [Symbol])",
  },
  {
    id: "rb-004-send-user-input",
    title: "send()/public_send() with user-controlled method name",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:send|public_send)\s*\(\s*(?:params\[|request\.|input|user_)/g,
    explanation:
      "send() invokes any method by name. With user input, attackers can call private/destructive methods like system(), exec(), or delete_all.",
    verify_prompt:
      "Is the method name from user input (params, request, form data)? " +
      "If from a hardcoded symbol or internal constant, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Whitelist: SAFE = %w[name email]; obj.public_send(method) if SAFE.include?(method)",
  },
  {
    id: "rb-005-mass-assignment",
    title: "Mass assignment without strong parameters",
    severity: "high",
    languages: ["ruby"],
    regex: /\.(?:new|create|update|update_attributes|assign_attributes)\s*\(\s*params(?!\s*\.\s*(?:require|permit))/g,
    explanation:
      "Passing params directly to model methods without permit/require allows attackers to set any column (is_admin, role, etc.).",
    verify_prompt:
      "Is params passed directly without .require().permit()? " +
      "If strong parameters are used (params.require(:user).permit(:name)), respond FALSE_POSITIVE. " +
      "If raw params hash, respond CONFIRMED.",
    cwe: "CWE-915",
    fix_template: "User.new(params.require(:user).permit(:name, :email))",
  },
  {
    id: "rb-006-system-backtick",
    title: "system()/backticks with user input (command injection)",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:system|%x)\s*(?:\(?\s*["'].*#\{|.*params|.*request)/g,
    explanation:
      "system(), %x{}, or backticks with interpolated user input enables OS command injection.",
    verify_prompt:
      "Does the shell command include user input via #{} interpolation or concatenation? " +
      "If the command is entirely hardcoded, respond FALSE_POSITIVE. " +
      "If user input is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use array form: system('ls', '-la', user_input) which avoids shell interpretation.",
  },
  {
    id: "rb-007-open-redirect",
    title: "Open redirect (redirect_to with user input)",
    severity: "medium",
    languages: ["ruby"],
    regex: /\bredirect_to\s*\(?\s*(?:params\[|request\.|input|url)/g,
    explanation:
      "redirect_to with user-controlled URL enables open redirect attacks (phishing). Attacker sends a link to your site that redirects to their malicious site.",
    verify_prompt:
      "Is the redirect URL from user input (params, query string, form)? " +
      "If redirecting to a hardcoded internal path or using only_path: true, respond FALSE_POSITIVE. " +
      "If user-controlled URL, respond CONFIRMED.",
    cwe: "CWE-601",
    fix_template: "Validate URL: redirect_to(params[:url]) only if URI(params[:url]).host == request.host",
  },
  {
    id: "rb-008-hardcoded-secrets",
    title: "Hardcoded secrets in Ruby",
    severity: "high",
    languages: ["ruby"],
    regex: /(?:secret_key|api_key|password|token|auth_token)\s*=\s*['"][A-Za-z0-9+/=_-]{12,}['"]/g,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repo access and persist in git history.",
    verify_prompt:
      "Is this a real secret or a placeholder/example value? " +
      "If test fixture or placeholder (e.g., 'changeme', 'test_token'), respond FALSE_POSITIVE. " +
      "If it looks like a real credential, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Use ENV['SECRET_KEY'] or Rails credentials (rails credentials:edit).",
  },
  {
    id: "rb-009-marshal-load",
    title: "Marshal.load with untrusted data",
    severity: "critical",
    languages: ["ruby"],
    regex: /\bMarshal\.load\s*\(/g,
    explanation:
      "Marshal.load deserializes arbitrary Ruby objects. Attackers can craft payloads that execute code on deserialization, similar to Java deserialization attacks.",
    verify_prompt:
      "Is the data being deserialized from a trusted source (internal cache, same-app storage) " +
      "or untrusted (network, user upload, cookie, shared storage)? " +
      "If trusted with integrity check, respond FALSE_POSITIVE. " +
      "If untrusted, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use JSON.parse() or YAML.safe_load() instead of Marshal.load.",
  },
  {
    id: "rb-010-sql-interpolation",
    title: "SQL injection via string interpolation in where clause",
    severity: "critical",
    languages: ["ruby"],
    regex: /\.where\s*\(\s*"[^"]*#\{/g,
    explanation:
      "String interpolation (#{}) inside ActiveRecord .where() bypasses parameterization. User input in the interpolated value enables SQL injection.",
    verify_prompt:
      "Does the #{} expression contain user input (params, request data)? " +
      "If the interpolated value is a constant or internal variable, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "User.where('email = ?', user_email) — use ? placeholders.",
  },
  {
    id: "rb-011-instance-eval-untrusted",
    title: "instance_eval/class_eval with untrusted string",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:instance_eval|class_eval)\s*\(\s*(?:params|request|input|data|body|str)/g,
    explanation:
      "instance_eval/class_eval with user-provided strings executes arbitrary Ruby code in the object's context, enabling RCE.",
    verify_prompt:
      "Is the evaluated string from user input or external data? " +
      "If from a hardcoded template or internal DSL, respond FALSE_POSITIVE. " +
      "If from untrusted source, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Use a block instead of string: instance_eval { method_call } or a whitelist approach.",
  },
  {
    id: "rb-012-eval-string",
    title: "eval() with string variable (code injection)",
    severity: "critical",
    languages: ["ruby"],
    regex: /\beval\s*\(\s*(?!['"])[a-zA-Z_]\w*/g,
    explanation:
      "eval() with a variable (not a string literal) executes arbitrary Ruby code. If the variable contains any user input, this is RCE.",
    verify_prompt:
      "Is the variable passed to eval() derived from user input or external data? " +
      "If it's a known-safe internal string (e.g., generated DSL, hardcoded template), respond FALSE_POSITIVE. " +
      "If it could contain untrusted data, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Avoid eval(). Use a hash lookup, case/when, or method dispatch with a whitelist.",
  },
];
