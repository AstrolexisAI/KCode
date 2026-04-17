// KCode - JAVA Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const JAVA_PATTERNS: BugPattern[] = [
  {
    id: "java-001-sql-injection",
    title: "SQL query with string concatenation",
    severity: "critical",
    languages: ["java"],
    regex: /\b(?:executeQuery|executeUpdate|execute|prepareStatement)\s*\(\s*(?:".*"\s*\+|.*\+\s*")/g,
    explanation: "SQL queries built with string concatenation are vulnerable to injection. Use PreparedStatement with parameterized queries.",
    verify_prompt: "Is user input concatenated into the SQL string? If using PreparedStatement with ?, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'Use PreparedStatement: ps = conn.prepareStatement("SELECT * FROM t WHERE id = ?"); ps.setString(1, id);',
  },
  {
    id: "java-002-deserialization",
    title: "Unsafe deserialization (ObjectInputStream)",
    severity: "critical",
    languages: ["java"],
    regex: /\bObjectInputStream\s*\(/g,
    explanation: "Java ObjectInputStream deserializes arbitrary objects. Attackers can craft payloads that execute code on deserialization (Commons Collections gadget chain, etc.).",
    verify_prompt: "Is the input stream from a trusted source (local file, internal service) or untrusted (network, user upload)? CONFIRMED if untrusted." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The data comes from a trusted internal source (local file written by the same app, internal service)\n" +
      "2. An ObjectInputFilter or class whitelist is configured before deserialization\n" +
      "3. This is in test code deserializing test fixtures\n" +
      "4. The stream is wrapped in a filtering/validating decorator\n" +
      "Only respond CONFIRMED if the deserialized data originates from untrusted input (network, user upload, external API) without filtering.",
    cwe: "CWE-502",
    fix_template: "Use JSON/Protobuf instead, or add a whitelist ObjectInputFilter.",
  },
  {
    id: "java-003-xxe",
    title: "XML parser without XXE protection",
    severity: "high",
    languages: ["java"],
    regex: /\b(?:DocumentBuilderFactory|SAXParserFactory|XMLInputFactory)\.newInstance\s*\(/g,
    explanation: "Default XML parsers in Java are vulnerable to XXE (XML External Entity) attacks. Disable external entities.",
    verify_prompt: "Is setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) or disallow-doctype-decl set? If protected, respond FALSE_POSITIVE.",
    cwe: "CWE-611",
    fix_template: 'factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);',
  },
  {
    id: "java-004-path-traversal",
    title: "File path from user input (path traversal)",
    severity: "high",
    languages: ["java"],
    regex: /new\s+File\s*\(\s*(?:request\.|param|input|arg)/g,
    explanation: "Creating File objects from user input allows path traversal (../../etc/passwd).",
    verify_prompt: "Is the file path derived from user/external input? If from internal config, respond FALSE_POSITIVE.",
    cwe: "CWE-22",
    fix_template: "Validate path: canonical = new File(base, input).getCanonicalPath(); if (!canonical.startsWith(base)) throw;",
  },

  // ── NullPointerException risk ──────────────────────────────────
  {
    id: "java-005-nullable-method-call",
    title: "Method call on nullable return without null check",
    severity: "high",
    languages: ["java"],
    regex: /\b(?:get|find|lookup|search|fetch|load|resolve|query)\w*\s*\([^)]*\)\s*\.\s*\w+\s*\(/g,
    explanation:
      "Calling a method on the return value of a get/find/lookup without checking for null first. If the lookup returns null, this throws NullPointerException.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Does the method have a @NonNull/@NotNull annotation on its return type? → FALSE_POSITIVE\n" +
      "2. Is the return value an Optional that is being unwrapped with .get()? (separate pattern) → FALSE_POSITIVE\n" +
      "3. Is there a null check on the same variable earlier in the method? → FALSE_POSITIVE\n" +
      "4. Does the method contract guarantee non-null (e.g., getOrDefault, computeIfAbsent)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the method can return null AND no check exists.",
    cwe: "CWE-476",
    fix_template: "Add null check: Object result = getX(); if (result != null) { result.method(); }",
  },

  // ── Resource leak ──────────────────────────────────────────────
  {
    id: "java-006-resource-leak",
    title: "InputStream/Connection not in try-with-resources",
    severity: "medium",
    languages: ["java"],
    regex: /\b(?:InputStream|OutputStream|FileReader|FileWriter|BufferedReader|BufferedWriter|Connection|Statement|ResultSet|Socket|RandomAccessFile)\s+\w+\s*=\s*(?:new\s|.*\.(?:open|get|create))\s*[^;]*;(?![\s\S]{0,50}?\btry\b)/g,
    explanation:
      "A closeable resource is assigned but not wrapped in try-with-resources. If an exception is thrown before close(), the resource leaks.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the resource declared inside a try-with-resources statement? → FALSE_POSITIVE\n" +
      "2. Is there a finally block that closes this resource? → FALSE_POSITIVE\n" +
      "3. Is the resource returned from the method (caller's responsibility)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the resource is opened, used, and no close mechanism exists.",
    cwe: "CWE-772",
    fix_template: "Wrap in try-with-resources: try (var stream = new FileInputStream(f)) { ... }",
  },

  // ── SQL injection in PreparedStatement ─────────────────────────
  {
    id: "java-007-sql-concat-prepared",
    title: "String concatenation in PreparedStatement SQL",
    severity: "critical",
    languages: ["java"],
    regex: /prepareStatement\s*\(\s*["'].*["']\s*\+/g,
    explanation:
      "Using string concatenation inside prepareStatement() defeats the purpose of parameterized queries. The concatenated part is still vulnerable to SQL injection.",
    verify_prompt:
      "Is user input being concatenated into the SQL string inside prepareStatement()? " +
      "If only constants (table names, column names) are concatenated, respond FALSE_POSITIVE. " +
      "If user-controlled values are concatenated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "Use ? placeholders for ALL user values: prepareStatement(\"SELECT * FROM t WHERE id = ?\");",
  },

  // ── ConcurrentModificationException ────────────────────────────
  {
    id: "java-008-concurrent-modification",
    title: "Modifying collection while iterating",
    severity: "high",
    languages: ["java"],
    regex: /for\s*\(\s*\w+(?:\s*<[^>]*>)?\s+\w+\s*:\s*(\w+)\s*\)[\s\S]{0,300}?\1\s*\.(?:add|remove|clear)\s*\(/g,
    explanation:
      "Modifying a collection (add/remove/clear) while iterating over it with a for-each loop throws ConcurrentModificationException at runtime.",
    verify_prompt:
      "Is the collection being modified the SAME collection being iterated? " +
      "If they are different collections (e.g., iterating copy, modifying original), respond FALSE_POSITIVE. " +
      "If same collection, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use Iterator.remove(), or collect items to remove and process after the loop, or use ConcurrentHashMap/CopyOnWriteArrayList.",
  },

  // ── Thread-unsafe singleton ────────────────────────────────────
  {
    id: "java-009-unsafe-singleton",
    title: "Lazy singleton without synchronization (race condition)",
    severity: "medium",
    languages: ["java"],
    regex: /if\s*\(\s*instance\s*==\s*null\s*\)\s*\{?\s*\n?\s*instance\s*=\s*new\b/g,
    explanation:
      "Lazy initialization of a singleton without synchronized or volatile allows two threads to create separate instances, breaking the singleton guarantee and causing subtle bugs.",
    verify_prompt:
      "Is this null-check + assignment inside a synchronized block, or is the field declared volatile with double-checked locking? " +
      "If properly synchronized, respond FALSE_POSITIVE. If unprotected, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use double-checked locking with volatile, or an enum singleton, or holder class pattern.",
  },

  // ── Hardcoded credentials ──────────────────────────────────────
  {
    id: "java-010-hardcoded-creds",
    title: "Hardcoded password, secret, or API key in Java",
    severity: "high",
    languages: ["java"],
    regex: /(?:password|passwd|secret|apiKey|api_key|token|credential)\s*=\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded credentials in Java source code are exposed to anyone with access to the compiled class files (strings are stored in plaintext in .class files).",
    verify_prompt:
      "Is this a REAL secret (not a placeholder like \"changeme\", not a test fixture, not an empty/example value)? " +
      "If it looks like a real credential, respond CONFIRMED. If test/placeholder, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Load from environment: System.getenv(\"API_KEY\") or use a secrets vault.",
  },

  // ── Insecure deserialization ───────────────────────────────────
  {
    id: "java-011-insecure-deserialize",
    title: "ObjectInputStream from untrusted source",
    severity: "critical",
    languages: ["java"],
    regex: /new\s+ObjectInputStream\s*\(\s*(?:request\.|socket\.|conn\.|input|stream|is\b)/g,
    explanation:
      "Creating ObjectInputStream from network/request streams deserializes arbitrary objects. Attackers can execute code via gadget chains (Commons Collections, Spring, etc.).",
    verify_prompt:
      "Is the InputStream from a network source (HTTP request, socket, RMI)? " +
      "If from a trusted local file written by the same application, respond FALSE_POSITIVE. " +
      "If from any network/untrusted source, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use JSON/Protobuf for network data, or add ObjectInputFilter to whitelist allowed classes.",
  },

  // ── Path traversal ─────────────────────────────────────────────
  {
    id: "java-012-path-traversal-string",
    title: "User input in File path without sanitization",
    severity: "high",
    languages: ["java"],
    regex: /new\s+File\s*\(\s*(?:.*\+\s*(?:param|input|request|user|name|path|filename))/gi,
    explanation:
      "Constructing File paths with unsanitized user input allows path traversal attacks (../../etc/passwd).",
    verify_prompt:
      "Is the user input validated/sanitized before being used in the File path? " +
      "Check for: canonical path comparison, regex filtering of ../, whitelist validation. " +
      "If validated, respond FALSE_POSITIVE. If raw user input, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "Validate: String safe = new File(base, input).getCanonicalPath(); if (!safe.startsWith(baseDir)) throw new SecurityException();",
  },

  // ── XXE injection ──────────────────────────────────────────────
  {
    id: "java-013-xxe-transformer",
    title: "XML TransformerFactory without disabling external entities",
    severity: "high",
    languages: ["java"],
    regex: /TransformerFactory\.newInstance\s*\(\s*\)/g,
    explanation:
      "Default TransformerFactory configuration allows XML external entities, enabling XXE attacks that can read local files or perform SSRF.",
    verify_prompt:
      "Is the TransformerFactory configured with setAttribute to disable external entities (ACCESS_EXTERNAL_DTD, ACCESS_EXTERNAL_STYLESHEET set to \"\")? " +
      "If protected, respond FALSE_POSITIVE. If default configuration, respond CONFIRMED.",
    cwe: "CWE-611",
    fix_template: "factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, \"\"); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, \"\");",
  },

  // ── Log injection ──────────────────────────────────────────────
  {
    id: "java-014-log-injection",
    title: "Unsanitized user input in log message",
    severity: "medium",
    languages: ["java"],
    regex: /\b(?:log|logger|LOG)\s*\.\s*(?:info|warn|error|debug|trace)\s*\(\s*(?:"[^"]*"\s*\+\s*(?:request|param|input|user|req\.))/gi,
    explanation:
      "Logging unsanitized user input allows log injection/forging. Attackers can inject newlines to create fake log entries or exploit log parsing tools.",
    verify_prompt:
      "Is user input being concatenated into the log message? " +
      "If using parameterized logging (logger.info(\"msg {}\", param)), respond FALSE_POSITIVE. " +
      "If string concatenation with user input, respond CONFIRMED.",
    cwe: "CWE-117",
    fix_template: "Use parameterized logging: logger.info(\"User login: {}\", sanitize(username));",
  },

  // ── Infinite loop ──────────────────────────────────────────────
  {
    id: "java-015-infinite-loop",
    title: "while(true) or for(;;) without break/return condition",
    severity: "medium",
    languages: ["java"],
    regex: /(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{(?:(?!\b(?:break|return|throw)\b)[\s\S]){0,500}?\}/g,
    explanation:
      "An infinite loop without a break, return, or throw will hang the thread indefinitely. This can cause DoS or resource exhaustion.",
    verify_prompt:
      "Does this loop body contain a break, return, throw, or System.exit() that provides an exit condition? " +
      "If an exit condition exists but the regex didn't capture it (long body), respond FALSE_POSITIVE. " +
      "If genuinely no exit condition, respond CONFIRMED.",
    cwe: "CWE-835",
    fix_template: "Add an explicit break/return condition, or use a bounded loop with a max iteration count.",
  },

  // ── equals without hashCode ────────────────────────────────────
  {
    id: "java-016-equals-no-hashcode",
    title: "equals() overridden without hashCode()",
    severity: "medium",
    languages: ["java"],
    regex: /public\s+boolean\s+equals\s*\(\s*Object\b(?![\s\S]{0,500}?public\s+int\s+hashCode\s*\(\s*\))/g,
    explanation:
      "Overriding equals() without hashCode() violates the Object contract. Objects that are equals() will have different hash codes, causing failures in HashMap, HashSet, and other hash-based collections.",
    verify_prompt:
      "Does this class also override hashCode()? Search the entire class, not just nearby lines. " +
      "If hashCode() is overridden (possibly further down in the file), respond FALSE_POSITIVE. " +
      "If only equals() is overridden, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Add @Override public int hashCode() { return Objects.hash(field1, field2); } consistent with equals().",
  },

  // ── Mutable static field ───────────────────────────────────────
  {
    id: "java-017-mutable-static",
    title: "Mutable static field (thread-safety risk)",
    severity: "medium",
    languages: ["java"],
    regex: /static\s+(?!final\b)(?:(?:private|public|protected)\s+)?(?:List|Map|Set|Collection|ArrayList|HashMap|HashSet|TreeMap|LinkedList|Queue|Deque)\s*<[^>]*>\s+\w+\s*=/g,
    explanation:
      "A non-final static collection field can be modified by any thread without synchronization, causing race conditions, ConcurrentModificationExceptions, or data corruption.",
    verify_prompt:
      "Is this static field properly synchronized (synchronized access, ConcurrentHashMap, Collections.synchronizedX, or volatile)? " +
      "If thread-safe access is ensured, respond FALSE_POSITIVE. If unprotected, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Make field final with an unmodifiable collection, or use ConcurrentHashMap/CopyOnWriteArrayList.",
  },

  // ── Catching generic Exception ─────────────────────────────────
  {
    id: "java-018-catch-generic-exception",
    title: "Catching generic Exception instead of specific type",
    severity: "low",
    languages: ["java"],
    regex: /\bcatch\s*\(\s*(?:Exception|Throwable)\s+\w+\s*\)/g,
    explanation:
      "Catching Exception or Throwable swallows all exceptions including programming errors (NullPointerException, ClassCastException) that should propagate. This hides bugs and makes debugging difficult.",
    verify_prompt:
      "Is this a top-level catch-all handler (e.g., main method, thread run, request handler) where catching broadly is intentional? " +
      "If it's a legitimate catch-all at a boundary, respond FALSE_POSITIVE. " +
      "If it's in business logic catching Exception to suppress errors, respond CONFIRMED.",
    cwe: "CWE-396",
    fix_template: "Catch specific exceptions: catch (IOException | SQLException e) { ... }",
  },
];
