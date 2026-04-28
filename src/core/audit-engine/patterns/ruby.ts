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
    // Categorical: regex requires the FIRST argument to be `params`,
    // `request`, or `input` — explicit user-controlled input. Every
    // match is a real RCE risk. Tagged high_precision.
    maturity: "high_precision",
    regex: /\b(?:eval|send|public_send|instance_eval|class_eval)\s*\(\s*(?:params|request|input)/g,
    explanation: "eval/send with user input enables arbitrary code execution.",
    verify_prompt: "Is the argument from user input? If internal/constant, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Use a whitelist: ALLOWED_METHODS.include?(method_name) && obj.public_send(method_name)",
  },
  {
    id: "rb-002-sql-injection",
    title: "SQL with string interpolation",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:where|find_by_sql|execute|select)\s*\(\s*"/g,
    explanation: "ActiveRecord/SQL with string interpolation is vulnerable to injection.",
    verify_prompt:
      "Is user input interpolated via #{}? If using ? placeholders, respond FALSE_POSITIVE.",
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
    verify_prompt:
      "Is the YAML from untrusted source? If from internal config file, respond FALSE_POSITIVE.",
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
    fix_template:
      "Whitelist: SAFE = %w[name email]; obj.public_send(method) if SAFE.include?(method)",
  },
  {
    id: "rb-005-mass-assignment",
    title: "Mass assignment without strong parameters",
    severity: "high",
    languages: ["ruby"],
    regex:
      /\.(?:new|create|update|update_attributes|assign_attributes)\s*\(\s*params(?!\s*\.\s*(?:require|permit))/g,
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
    fix_template:
      "Use array form: system('ls', '-la', user_input) which avoids shell interpretation.",
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
    fix_template:
      "Validate URL: redirect_to(params[:url]) only if URI(params[:url]).host == request.host",
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
    fix_template:
      "Use a block instead of string: instance_eval { method_call } or a whitelist approach.",
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
    fix_template:
      "Avoid eval(). Use a hash lookup, case/when, or method dispatch with a whitelist.",
  },

  // ── v2.10.333 — Phase A round 2 (Ruby) ────────────────────────
  {
    id: "rb-013-ssrf-net-http",
    title: "Net::HTTP / open-uri / Faraday / HTTParty with user URL (SSRF)",
    severity: "high",
    languages: ["ruby"],
    regex:
      /\b(?:Net::HTTP\.(?:get|post|start)|URI\.open|HTTParty\.(?:get|post)|Faraday\.(?:get|post)|RestClient\.(?:get|post))\s*\([^)\n]{0,120}?params\[/g,
    explanation:
      "Server-Side Request Forgery: the Rails / Sinatra app fetches a URL chosen by the attacker. Net::HTTP and URI.open both honor http://, https://, AND file://, ftp:// schemes — a request like `params[:url]=file:///etc/passwd` reads server files. Used to reach internal services or steal cloud metadata.",
    verify_prompt:
      "Is there an allowlist check (host or scheme) before the call?\n" +
      "1. URL host is compared against a fixed set of allowed hosts → FALSE_POSITIVE.\n" +
      "2. URI(url).scheme is restricted to https only → FALSE_POSITIVE.\n" +
      "3. The URL is from a config file / Rails.application.credentials, not params[] → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when params[:url] / request.params reaches the call unfiltered.",
    cwe: "CWE-918",
    fix_template:
      "Validate scheme + host: `u = URI.parse(params[:url]); raise unless u.scheme == 'https' && ALLOWLIST.include?(u.host)`. Block file://, ftp://, gopher://, RFC1918 / 127/8 / 169.254.169.254 IPs.",
  },
  {
    id: "rb-014-send-file-traversal",
    title: "send_file / send_data with params-derived path (path traversal)",
    severity: "high",
    languages: ["ruby"],
    regex: /\bsend_file\s+(?:Rails\.root\.join\s*\(\s*)?(?:[^,)\n]*,\s*)*params\[/g,
    explanation:
      "Rails send_file with a path built from params lets an attacker read any file the Rails process can read. `?file=../../etc/passwd` walks out of the public directory. Even with `Rails.root.join`, the user-supplied component is not normalized — Pathname.new('a/../../../etc/passwd') still resolves outside the root.",
    verify_prompt:
      "Is the user-supplied path component validated?\n" +
      "1. Allowlist of known filenames (whitelist of public assets) → FALSE_POSITIVE.\n" +
      "2. Resolved with Pathname#realpath then `.start_with?(allowed_root.realpath.to_s + '/')` check → FALSE_POSITIVE.\n" +
      "3. The path is built from a database ID, not the literal filename → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when params[:file] / params[:filename] reaches the path argument as a substring.",
    cwe: "CWE-22",
    fix_template:
      "Look up the file by ID, not by path. If you must accept a name: `name = File.basename(params[:file]); raise unless ALLOWED_NAMES.include?(name)`.",
  },
];
