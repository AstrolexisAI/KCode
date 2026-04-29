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
    regex:
      /\b(?:executeQuery|executeUpdate|execute|prepareStatement)\s*\(\s*(?:".*"\s*\+|.*\+\s*")/g,
    explanation:
      "SQL queries built with string concatenation are vulnerable to injection. Use PreparedStatement with parameterized queries.",
    verify_prompt:
      "Is user input concatenated into the SQL string? If using PreparedStatement with ?, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template:
      'Use PreparedStatement: ps = conn.prepareStatement("SELECT * FROM t WHERE id = ?"); ps.setString(1, id);',
  },
  {
    id: "java-002-deserialization",
    title: "Unsafe deserialization (ObjectInputStream)",
    severity: "critical",
    languages: ["java"],
    regex: /\bObjectInputStream\s*\(/g,
    explanation:
      "Java ObjectInputStream deserializes arbitrary objects. Attackers can craft payloads that execute code on deserialization (Commons Collections gadget chain, etc.).",
    verify_prompt:
      "Is the input stream from a trusted source (local file, internal service) or untrusted (network, user upload)? CONFIRMED if untrusted." +
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
    explanation:
      "Default XML parsers in Java are vulnerable to XXE (XML External Entity) attacks. Disable external entities.",
    verify_prompt:
      "Is setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) or disallow-doctype-decl set? If protected, respond FALSE_POSITIVE.",
    cwe: "CWE-611",
    fix_template:
      'factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);',
  },
  {
    id: "java-004-path-traversal",
    title: "File path from user input (path traversal)",
    severity: "high",
    languages: ["java"],
    regex: /new\s+File\s*\(\s*(?:request\.|param|input|arg)/g,
    explanation: "Creating File objects from user input allows path traversal (../../etc/passwd).",
    verify_prompt:
      "Is the file path derived from user/external input? If from internal config, respond FALSE_POSITIVE.",
    cwe: "CWE-22",
    fix_template:
      "Validate path: canonical = new File(base, input).getCanonicalPath(); if (!canonical.startsWith(base)) throw;",
  },

  // ── NullPointerException risk ──────────────────────────────────
  {
    id: "java-005-nullable-method-call",
    title: "Method call on nullable return without null check",
    severity: "medium",
    category: "quality",
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
    fix_template:
      "Add null check: Object result = getX(); if (result != null) { result.method(); }",
  },

  // ── Resource leak ──────────────────────────────────────────────
  {
    id: "java-006-resource-leak",
    title: "InputStream/Connection not in try-with-resources",
    severity: "medium",
    category: "quality",
    languages: ["java"],
    regex:
      /\b(?:InputStream|OutputStream|FileReader|FileWriter|BufferedReader|BufferedWriter|Connection|Statement|ResultSet|Socket|RandomAccessFile)\s+\w+\s*=\s*(?:new\s|.*\.(?:open|get|create))\s*[^;]*;(?![\s\S]{0,50}?\btry\b)/g,
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
    fix_template:
      'Use ? placeholders for ALL user values: prepareStatement("SELECT * FROM t WHERE id = ?");',
  },

  // ── ConcurrentModificationException ────────────────────────────
  {
    id: "java-008-concurrent-modification",
    title: "Modifying collection while iterating",
    severity: "high",
    languages: ["java"],
    regex:
      /for\s*\(\s*\w+(?:\s*<[^>]*>)?\s+\w+\s*:\s*(\w+)\s*\)[\s\S]{0,300}?\1\s*\.(?:add|remove|clear)\s*\(/g,
    explanation:
      "Modifying a collection (add/remove/clear) while iterating over it with a for-each loop throws ConcurrentModificationException at runtime.",
    verify_prompt:
      "Is the collection being modified the SAME collection being iterated? " +
      "If they are different collections (e.g., iterating copy, modifying original), respond FALSE_POSITIVE. " +
      "If same collection, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template:
      "Use Iterator.remove(), or collect items to remove and process after the loop, or use ConcurrentHashMap/CopyOnWriteArrayList.",
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
    fix_template:
      "Use double-checked locking with volatile, or an enum singleton, or holder class pattern.",
  },

  // ── Hardcoded credentials ──────────────────────────────────────
  {
    id: "java-010-hardcoded-creds",
    title: "Hardcoded password, secret, or API key in Java",
    severity: "high",
    languages: ["java"],
    // Categorical: hardcoded credentials in source are wrong
    // every time. The verify_prompt only filters
    // placeholder/test-fixture strings; the secret pattern
    // itself is unconditional.
    maturity: "high_precision",
    regex: /(?:password|passwd|secret|apiKey|api_key|token|credential)\s*=\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded credentials in Java source code are exposed to anyone with access to the compiled class files (strings are stored in plaintext in .class files).",
    verify_prompt:
      'Is this a REAL secret (not a placeholder like "changeme", not a test fixture, not an empty/example value)? ' +
      "If it looks like a real credential, respond CONFIRMED. If test/placeholder, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: 'Load from environment: System.getenv("API_KEY") or use a secrets vault.',
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
    fix_template:
      "Use JSON/Protobuf for network data, or add ObjectInputFilter to whitelist allowed classes.",
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
    fix_template:
      "Validate: String safe = new File(base, input).getCanonicalPath(); if (!safe.startsWith(baseDir)) throw new SecurityException();",
  },

  // ── XXE injection ──────────────────────────────────────────────
  {
    id: "java-013-xxe-transformer",
    title: "XML TransformerFactory without disabling external entities",
    severity: "high",
    languages: ["java"],
    // Categorical: any `TransformerFactory.newInstance()` is XXE-
    // vulnerable by default unless the caller subsequently sets
    // FEATURE_SECURE_PROCESSING and disables external DTDs/entities.
    // The verify_prompt filters cases where the secure features are
    // applied; the API call itself is unconditionally a smell.
    maturity: "high_precision",
    regex: /TransformerFactory\.newInstance\s*\(\s*\)/g,
    explanation:
      "Default TransformerFactory configuration allows XML external entities, enabling XXE attacks that can read local files or perform SSRF.",
    verify_prompt:
      'Is the TransformerFactory configured with setAttribute to disable external entities (ACCESS_EXTERNAL_DTD, ACCESS_EXTERNAL_STYLESHEET set to "")? ' +
      "If protected, respond FALSE_POSITIVE. If default configuration, respond CONFIRMED.",
    cwe: "CWE-611",
    fix_template:
      'factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, ""); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");',
  },

  // ── Log injection ──────────────────────────────────────────────
  {
    id: "java-014-log-injection",
    title: "Unsanitized user input in log message",
    severity: "medium",
    languages: ["java"],
    regex:
      /\b(?:log|logger|LOG)\s*\.\s*(?:info|warn|error|debug|trace)\s*\(\s*(?:"[^"]*"\s*\+\s*(?:request|param|input|user|req\.))/gi,
    explanation:
      "Logging unsanitized user input allows log injection/forging. Attackers can inject newlines to create fake log entries or exploit log parsing tools.",
    verify_prompt:
      "Is user input being concatenated into the log message? " +
      'If using parameterized logging (logger.info("msg {}", param)), respond FALSE_POSITIVE. ' +
      "If string concatenation with user input, respond CONFIRMED.",
    cwe: "CWE-117",
    fix_template: 'Use parameterized logging: logger.info("User login: {}", sanitize(username));',
  },

  // ── Infinite loop ──────────────────────────────────────────────
  {
    id: "java-015-infinite-loop",
    title: "while(true) or for(;;) without break/return condition",
    severity: "medium",
    languages: ["java"],
    regex:
      /(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{(?:(?!\b(?:break|return|throw)\b)[\s\S]){0,500}?\}/g,
    explanation:
      "An infinite loop without a break, return, or throw will hang the thread indefinitely. This can cause DoS or resource exhaustion.",
    verify_prompt:
      "Does this loop body contain a break, return, throw, or System.exit() that provides an exit condition? " +
      "If an exit condition exists but the regex didn't capture it (long body), respond FALSE_POSITIVE. " +
      "If genuinely no exit condition, respond CONFIRMED.",
    cwe: "CWE-835",
    fix_template:
      "Add an explicit break/return condition, or use a bounded loop with a max iteration count.",
  },

  // ── equals without hashCode ────────────────────────────────────
  {
    id: "java-016-equals-no-hashcode",
    title: "equals() overridden without hashCode()",
    severity: "medium",
    languages: ["java"],
    regex:
      /public\s+boolean\s+equals\s*\(\s*Object\b(?![\s\S]{0,500}?public\s+int\s+hashCode\s*\(\s*\))/g,
    explanation:
      "Overriding equals() without hashCode() violates the Object contract. Objects that are equals() will have different hash codes, causing failures in HashMap, HashSet, and other hash-based collections.",
    verify_prompt:
      "Does this class also override hashCode()? Search the entire class, not just nearby lines. " +
      "If hashCode() is overridden (possibly further down in the file), respond FALSE_POSITIVE. " +
      "If only equals() is overridden, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template:
      "Add @Override public int hashCode() { return Objects.hash(field1, field2); } consistent with equals().",
  },

  // ── Mutable static field ───────────────────────────────────────
  {
    id: "java-017-mutable-static",
    title: "Mutable static field (thread-safety risk)",
    severity: "medium",
    languages: ["java"],
    regex:
      /static\s+(?!final\b)(?:(?:private|public|protected)\s+)?(?:List|Map|Set|Collection|ArrayList|HashMap|HashSet|TreeMap|LinkedList|Queue|Deque)\s*<[^>]*>\s+\w+\s*=/g,
    explanation:
      "A non-final static collection field can be modified by any thread without synchronization, causing race conditions, ConcurrentModificationExceptions, or data corruption.",
    verify_prompt:
      "Is this static field properly synchronized (synchronized access, ConcurrentHashMap, Collections.synchronizedX, or volatile)? " +
      "If thread-safe access is ensured, respond FALSE_POSITIVE. If unprotected, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template:
      "Make field final with an unmodifiable collection, or use ConcurrentHashMap/CopyOnWriteArrayList.",
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

  // ── v2.10.333 — Phase A round 2 (Java) ────────────────────────
  {
    id: "java-019-tls-trust-all",
    title: "TrustManager that accepts every certificate (TLS bypass)",
    severity: "critical",
    languages: ["java", "kotlin"],
    // Categorical: an empty checkServerTrusted/checkClientTrusted/
    // verify body in a TrustManager / HostnameVerifier is wrong every
    // time. The regex matches that exact shape; legitimate
    // implementations always have actual logic in those bodies.
    maturity: "high_precision",
    regex:
      /(?:new\s+(?:X509TrustManager|HostnameVerifier)\s*\(\s*\)\s*\{[^}]*?(?:checkServerTrusted|checkClientTrusted|verify)[^}]*?\{\s*\}|new\s+TrustManager\s*\[\s*\]\s*\{[^}]*?@Override[^}]*?\{\s*\})/g,
    explanation:
      "An X509TrustManager whose checkServerTrusted is empty (or a HostnameVerifier whose verify always returns true) accepts every certificate including self-signed and attacker-presented ones. Any MITM on the path can decrypt and forge the traffic.",
    verify_prompt:
      "Is this in a production code path or a test fixture?\n" +
      '1. If in src/test/ or wrapped in `if (env.equals("test"))` → FALSE_POSITIVE.\n' +
      "2. If the empty-body method actually pins a specific cert (compares against a known fingerprint inside the body) → FALSE_POSITIVE.\n" +
      "3. If the trust-all is gated behind a config flag that's off in production → FALSE_POSITIVE (still flag for review).\n" +
      "Only CONFIRMED when the trust manager is unconditional and reachable from production.",
    cwe: "CWE-295",
    fix_template:
      "Use the JDK default TrustManager. If self-signed certs are required, add the specific CA to the trust store rather than disabling validation.",
  },
  {
    id: "java-020-ssrf-resttemplate",
    title: "RestTemplate / WebClient / OkHttp with user-controllable URL",
    severity: "high",
    languages: ["java", "kotlin"],
    regex:
      /\b(?:restTemplate\.(?:getForObject|getForEntity|postForObject|exchange)|webClient\.(?:get|post)\s*\(\s*\)\s*\.uri|okHttpClient\.newCall\s*\(\s*new\s+Request\.Builder\s*\(\s*\)\s*\.url|HttpClient\.newBuilder)\s*\([^)]*(?:request\.|@RequestParam|@PathVariable|input|userUrl)\b/gi,
    explanation:
      "Server-Side Request Forgery: the server fetches a URL chosen by the attacker. Used to reach internal services (Redis, metadata endpoints like 169.254.169.254 on AWS, admin panels), bypassing network perimeters. Capital One 2019 breach was a Java RestTemplate SSRF.",
    verify_prompt:
      "Check before confirming. FALSE_POSITIVE if ANY:\n" +
      "1. URL goes through an allowlist (host comparison against a fixed list, scheme restricted to https) BEFORE the call → FALSE_POSITIVE.\n" +
      "2. The hostname is resolved and the IP is checked to NOT be RFC1918 / loopback / link-local before fetch → FALSE_POSITIVE.\n" +
      "3. URL is from a config file the operator owns, not a request parameter → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when an HTTP request parameter / path variable / form field reaches the URL argument with no filtering.",
    cwe: "CWE-918",
    fix_template:
      "Allowlist permitted hosts. Block RFC1918, 127/8, ::1, 169.254.169.254 (AWS/GCP/Azure metadata). Resolve the hostname first and validate the IP, not just the input string.",
  },
  {
    id: "java-021-spring-restbody-map",
    title: "Spring @RequestBody Map<String,Object> used directly in business logic",
    severity: "high",
    languages: ["java", "kotlin"],
    regex: /@RequestBody\s+(?:final\s+)?Map\s*<\s*String\s*,\s*(?:Object|\?)\s*>/g,
    explanation:
      "Binding the request body to a raw Map<String,Object> defeats schema validation. Any field the attacker sends ends up in the map, and downstream code may persist privileged fields (isAdmin, role, balance) without realizing they came from outside. Use a typed DTO with explicit @JsonIgnore / Bean Validation.",
    verify_prompt:
      "Does the handler immediately validate / extract specific keys from the map (with whitelisting), or does it pass the map directly to a save / update / merge call?\n" +
      "1. If keys are extracted by name and only known-safe fields are used → FALSE_POSITIVE.\n" +
      "2. If the map is forwarded into ObjectMapper.convertValue(map, ConcreteDto.class) where ConcreteDto has explicit fields → FALSE_POSITIVE (still consider migrating to typed binding).\n" +
      "3. If the map is iterated and applied to an entity via reflection / setProperty → CONFIRMED (mass-assignment hole).\n" +
      "Only CONFIRMED when an externally-controlled map reaches a side-effecting call without per-field allowlisting.",
    cwe: "CWE-915",
    fix_template:
      "Replace `Map<String,Object>` with a typed DTO. Use Bean Validation (@Valid + @NotNull / @Size) for schema enforcement.",
  },

  // ────────────────────────────────────────────────────────────────
  // OWASP Benchmark v1.2 coverage round (v2.10.398)
  //
  // The categories below close the gap surfaced by running KCode on
  // OWASP Benchmark v1.2 — KCode previously had 0% recall on sqli /
  // xss / cmdi / weakrand / pathtraver / ldapi / securecookie /
  // trustbound because the existing Java patterns didn't match the
  // OWASP-style "var = user-input; sink(var);" two-statement shape.
  //
  // The patterns below use one of three approaches per category:
  //   1. Direct call-site match (weakrand: `new Random` / `Math.random`)
  //   2. Var-flow within ~300 chars (sqli, xss, cmdi, pathtraver, ldapi)
  //   3. Negative lookahead for missing safety call (securecookie)
  //
  // All ship with positive + negative fixtures under tests/patterns/.
  // ────────────────────────────────────────────────────────────────

  // ── Weak random for security purposes (CWE-338) ────────────────
  {
    id: "java-022-weak-random-security",
    title: "java.util.Random / Math.random used for security purposes",
    severity: "high",
    languages: ["java"],
    // Categorical: any use of java.util.Random / Math.random for a
    // security purpose is wrong. The verify_prompt confirms whether
    // the output reaches a security sink, but the API call itself is
    // unconditional. 100% precision on OWASP Benchmark v1.2 (243/243).
    maturity: "high_precision",
    // (?<!Secure) avoids matching `SecureRandom`. (?<!\w) avoids
    // matching as part of an identifier. Both lookbehinds are
    // fixed-width so JS regex accepts them.
    regex:
      /(?<!Secure)(?<!\w)(?:new\s+(?:java\.util\.)?Random\s*\(|(?:java\.lang\.)?Math\.random\s*\()/g,
    explanation:
      "java.util.Random and Math.random() are NOT cryptographically secure. They are seeded with low-entropy values (System.nanoTime by default) and predictable from a single observation. Using them to generate session tokens, password reset keys, IVs, nonces, or any security-sensitive value is CWE-338. Use java.security.SecureRandom instead.",
    verify_prompt:
      "Is the output of this RNG used for security purposes — a session token, auth cookie, CSRF token, password reset key, IV, nonce, or key material?\n" +
      "1. CONFIRMED if used for any of: token, key, nonce, iv, salt, session, secret, password, csrf, rememberMe, or written into HTTP responses to the client.\n" +
      "2. FALSE_POSITIVE if used for non-security randomness (animation jitter, game mechanics, shuffle, test fixtures, retry backoff, sampling, percentile pick, LBS).",
    cwe: "CWE-338",
    fix_template:
      "Replace with java.security.SecureRandom: SecureRandom rand = SecureRandom.getInstanceStrong(); int n = rand.nextInt(...);",
  },

  // ── SQL injection: var-flow shape (CWE-89) ─────────────────────
  // Matches: String sql = "..." + .* + "..."; … prepareCall|prepareStatement|executeQuery(sql)
  // OWASP Benchmark sqli cases use this shape; the existing
  // java-001 only matches inline concat at the call site.
  {
    id: "java-023-sql-injection-var-flow",
    title: "SQL string built with concatenation flows into prepareStatement/Call/Query",
    severity: "critical",
    languages: ["java"],
    regex:
      /\bString\s+(\w+)\s*=\s*[^;]*\+[^;]*;[\s\S]{0,400}?\b(?:prepareCall|prepareStatement|createStatement\s*\(\s*\)\s*\.\s*execute(?:Query|Update|Batch)?|executeQuery|executeUpdate|executeBatch|execute|addBatch|queryForRowSet|queryForList|queryForObject|queryForMap|queryForInt|queryForLong|query|update|batchUpdate)\s*\(\s*\1\s*[,)]/g,
    explanation:
      "A SQL string is built with concatenation in one statement and passed to prepareStatement / prepareCall / executeQuery in a later statement. Even though the dangerous call uses a variable rather than a literal concat, the variable carries the same injection vector. This is the canonical OWASP Benchmark shape — see BenchmarkTest00008 etc.",
    verify_prompt:
      "Trace the variable on the right-hand side of the String assignment.\n" +
      "1. CONFIRMED if any concatenated value originates from request.getParameter / getCookies / getHeader / getRequestURI etc.\n" +
      "2. FALSE_POSITIVE if all concatenated values are class constants, env vars, or come from a sanitizer (Pattern.matches with anchored regex, Integer.parseInt → result re-stringified, ESAPI).\n" +
      "3. FALSE_POSITIVE if the variable is only used for debug logging (no execute() call reached).",
    cwe: "CWE-89",
    fix_template:
      'Use parameterized queries: String sql = "SELECT * FROM t WHERE id = ?"; PreparedStatement ps = conn.prepareStatement(sql); ps.setString(1, userInput);',
  },

  // ── XSS via response.getWriter() (CWE-79) ──────────────────────
  // Matches: response.getWriter().<method>(...) where the argument
  // contains user input (request.getParameter / getCookies) directly
  // or via a String var concatenated from those sources.
  {
    id: "java-024-xss-writer-direct",
    title: "Servlet writes request input to response.getWriter() without HTML-encoding",
    severity: "critical",
    languages: ["java"],
    // Tight pattern: requires the writer call AND a Servlet API
    // source name within the same line. False positives only when
    // an encoder is applied between source and sink, which the
    // verifier catches. 100% precision on OWASP Benchmark v1.2 (9/9).
    maturity: "high_precision",
    regex:
      /\bresponse\.getWriter\s*\(\s*\)\s*\.\s*(?:print|println|write|format|append)\s*\(\s*[^)]*\b(?:request\.(?:getParameter|getHeader|getQueryString|getCookies|getRequestURI)|param|userInput|userName|fileName)\b/g,
    explanation:
      "User input from request.getParameter / cookies / headers is written directly to the HTTP response. Any HTML / JS in the input renders in the victim's browser → reflected XSS (CWE-79). Use Encode.forHtml() / ESAPI / OWASP Java Encoder before writing.",
    verify_prompt:
      "Does the value reaching getWriter().print/println/write include attacker-controlled data WITHOUT an HTML encoder applied?\n" +
      "1. FALSE_POSITIVE if the value passes through Encode.forHtml(), HtmlUtils.htmlEscape, ESAPI.encoder().encodeForHTML(), or org.owasp.encoder.\n" +
      "2. FALSE_POSITIVE if the value is content-type: application/json AND the response is set to Content-Type: application/json (browser won't render).\n" +
      "3. CONFIRMED otherwise.",
    cwe: "CWE-79",
    fix_template:
      "Encode before writing: response.getWriter().write(org.owasp.encoder.Encode.forHtml(userInput));",
  },

  // ── Command injection: Runtime.exec / ProcessBuilder (CWE-78) ──
  {
    id: "java-025-command-injection",
    title: "Runtime.exec / ProcessBuilder receives concatenated user input",
    severity: "critical",
    languages: ["java"],
    regex:
      /\b(?:Runtime\.getRuntime\s*\(\s*\)\s*\.\s*exec|new\s+ProcessBuilder\s*\(?)\s*\(?[^)]*\b(?:request\.getParameter|request\.getHeader|request\.getCookies|param|userInput)\b|\bString\s+(\w+)\s*=\s*[^;]*\b(?:request\.getParameter|request\.getHeader|getCookies)\b[^;]*;[\s\S]{0,300}?\b(?:Runtime\.getRuntime\s*\(\s*\)\s*\.\s*exec|new\s+ProcessBuilder)\s*\(?\s*\1\b/g,
    explanation:
      "User-controlled input is concatenated into a shell command and passed to Runtime.exec or ProcessBuilder. Shell metacharacters (; | & $() ` \\n) execute arbitrary commands. CWE-78. Even ProcessBuilder isn't safe when the user input is an argument vector built from concat.",
    verify_prompt:
      "Is the command string or argument array constructed from request.* without strict whitelist validation?\n" +
      "1. FALSE_POSITIVE if input is matched against a fixed allow-list (Pattern.matches with ^[a-z]+$ etc.) before exec.\n" +
      "2. FALSE_POSITIVE if input is parsed to int/enum first (e.g., Integer.parseInt → switch on the int).\n" +
      "3. CONFIRMED if any path from request.* reaches the exec / ProcessBuilder call.",
    cwe: "CWE-78",
    fix_template:
      "Use ProcessBuilder with a hard-coded command + validated args, or shell out via a helper that escapes args. Never concatenate user input into a shell line.",
  },

  // ── Path traversal: var-flow into File / Files / Path (CWE-22) ─
  {
    id: "java-026-path-traversal-var-flow",
    title: "User input flows into File / Files / FileInputStream / Path without canonicalization",
    severity: "critical",
    languages: ["java"],
    regex:
      /\bString\s+(\w+)\s*=\s*[^;]*\b(?:request\.getParameter|getCookies|getHeader|getRequestURI)\b[^;]*;[\s\S]{0,400}?\b(?:new\s+(?:File|FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile)\s*\(|Files\.(?:newInputStream|newOutputStream|newBufferedReader|newBufferedWriter|readString|readAllBytes|write|copy|move|delete|exists)|Paths\.get)\s*\([^)]*\b\1\b/g,
    explanation:
      "User input is used to construct a file path without normalizing for `..` traversal. CWE-22. Even if a base directory is prepended, an attacker can submit `../../etc/passwd` to escape it.",
    verify_prompt:
      "Trace the variable from the String assignment to the File / Files / Paths call.\n" +
      "1. FALSE_POSITIVE if the input is sanitized via getCanonicalPath() + a startsWith(baseDir.getCanonicalPath()) check.\n" +
      "2. FALSE_POSITIVE if the input passes through a strict allow-list (Pattern.matches with anchored ^[\\w-]+$ — no slashes, no dots).\n" +
      "3. CONFIRMED otherwise — even a base-dir prefix doesn't prevent `../../../etc/passwd`.",
    cwe: "CWE-22",
    fix_template:
      "Canonicalize and validate: Path resolved = baseDir.resolve(userInput).normalize(); if (!resolved.startsWith(baseDir)) throw new SecurityException();",
  },

  // ── LDAP injection (CWE-90) ────────────────────────────────────
  {
    id: "java-027-ldap-injection",
    title: "DirContext.search receives LDAP filter built from user input",
    severity: "critical",
    languages: ["java"],
    regex:
      /\bString\s+(\w+)\s*=\s*[^;]*\b(?:request\.getParameter|getCookies|getHeader)\b[^;]*;[\s\S]{0,400}?\.(?:search|searchSubtree)\s*\([^)]*\b\1\b|\.(?:search|searchSubtree)\s*\([^)]*\+[^)]*\b(?:request\.getParameter|getCookies|getHeader)\b/g,
    explanation:
      "User input is concatenated into an LDAP filter and passed to DirContext.search. Without escaping, an attacker can inject LDAP operators (`*)(uid=*` etc.) to bypass authentication or extract directory contents. CWE-90.",
    verify_prompt:
      "Is the LDAP filter constructed from request.* without escaping?\n" +
      "1. FALSE_POSITIVE if the input is escaped via a known LDAP encoder (ESAPI.encoder().encodeForLDAP, Encode.forLDAP, manual escape of *()\\\\ chars).\n" +
      "2. FALSE_POSITIVE if input passes through Pattern.matches against a strict allow-list.\n" +
      "3. CONFIRMED otherwise.",
    cwe: "CWE-90",
    fix_template:
      "Escape per RFC 4515: Encode.forLDAP(userInput) or use parameterized JNDI search controls.",
  },

  // ── Insecure cookie: missing setSecure / setHttpOnly (CWE-614 / CWE-1004) ─
  {
    id: "java-028-cookie-missing-secure-flags",
    title: "Cookie added to response without setSecure(true) and setHttpOnly(true)",
    severity: "high",
    languages: ["java"],
    // Match: new Cookie(...) followed by addCookie within ~300 chars
    // WITHOUT both setSecure and setHttpOnly being set on the variable
    // in between. This is harder to express purely as regex — simpler
    // approach: match the addCookie call site and rely on the LLM
    // verifier to check the absence of safety calls.
    regex: /\bresponse\.addCookie\s*\(\s*(\w+)\s*\)/g,
    explanation:
      "A Cookie object is added to the HTTP response. If setSecure(true) is not called, the cookie can leak over plain HTTP. If setHttpOnly(true) is not called, JavaScript can read the cookie (XSS theft). CWE-614, CWE-1004.",
    verify_prompt:
      "Trace the cookie variable backward to its construction.\n" +
      "1. FALSE_POSITIVE if BOTH setSecure(true) AND setHttpOnly(true) appear on the cookie variable before addCookie.\n" +
      "2. FALSE_POSITIVE if the cookie is documented as a non-sensitive UI cookie (e.g., theme preference) and the file's authoritative session cookie is set elsewhere with the right flags.\n" +
      "3. CONFIRMED if either setSecure or setHttpOnly is missing.",
    cwe: "CWE-614",
    fix_template:
      "Set both flags: cookie.setSecure(true); cookie.setHttpOnly(true); response.addCookie(cookie);",
  },

  // ── Trust boundary violation: user input into HttpSession (CWE-501) ─
  {
    id: "java-029-trustbound-session-attr",
    title: "User input stored directly in HttpSession without validation",
    severity: "high",
    languages: ["java"],
    regex:
      /\b(?:request\.)?getSession\s*\([^)]*\)\s*\.\s*setAttribute\s*\(\s*[^,]+,\s*(?:request\.(?:getParameter|getHeader|getCookies|getRequestURI)|[^)]*\+\s*request\.(?:getParameter|getHeader|getCookies))/g,
    explanation:
      "Untrusted request input is stored in the HttpSession. Downstream code that reads the session attribute will trust the value as authenticated context — but the user controls it. CWE-501. Common shape on OWASP Benchmark trustbound category.",
    verify_prompt:
      "Is the value stored in the session a raw request input?\n" +
      "1. FALSE_POSITIVE if the input passes through Pattern.matches with an anchored allow-list before session.setAttribute.\n" +
      "2. FALSE_POSITIVE if the input is parsed to a strict type (int / enum) first and the session stores the parsed value, not the string.\n" +
      "3. CONFIRMED if request.getParameter / getCookies / getHeader flows into setAttribute without normalization.",
    cwe: "CWE-501",
    fix_template:
      'Validate and parse the input into a strict type before storing in the session: int userId = Integer.parseInt(request.getParameter("id")); session.setAttribute("userId", userId);',
  },

  // ── Broader patterns: catch the SINK call with a variable arg, let
  // the LLM verifier confirm if the variable traces to user input.
  // These complement the narrower var-flow regexes above when the
  // user input is reassigned, transformed, or wrapped before reaching
  // the sink. Recall lift > precision drop on OWASP — verifier
  // confirms or drops in production deployment.

  // ── XSS broad: getWriter().method(non-literal) (CWE-79) ────────
  {
    id: "java-030-xss-writer-non-literal",
    title: "Servlet writes a non-literal value to response.getWriter()",
    severity: "high",
    languages: ["java"],
    // Match getWriter().X( permissively: any first arg that isn't a
    // bare numeric literal. Quoted strings and concats starting with
    // a literal both match — the "literal + tainted" shape is real
    // xss (`println("prefix " + tainted)`), and pure-literal-only
    // calls (`println("hello")`) get classified as `constant` by the
    // sink-call extractor downstream and suppressed there with
    // recall-safe semantics (audit-engine v2.10.403 logic).
    //
    // Includes `printf` in the method alternation (missing in
    // v2.10.398). Locale-first calls like `format(Locale.US, fmt,
    // obj)` are intentionally matched; extractSinkCallArg in
    // taint/java.ts skips the Locale on the arg side so the verdict
    // examines arg[1].
    regex:
      /\bresponse\.getWriter\s*\(\s*\)\s*\.\s*(?:print|println|printf|write|format|append)\s*\(\s*(?!\d+\s*\))/g,
    explanation:
      "response.getWriter() is being called with a non-literal first argument. If that value originated from request.getParameter / getHeader / getCookies anywhere in the method (even after transformations like URLDecoder.decode), it's reflected XSS. CWE-79.",
    verify_prompt:
      "Trace the first argument back to its definition.\n" +
      "1. CONFIRMED if any path leads to request.getParameter / getHeader / getCookies / getRequestURI.\n" +
      "2. FALSE_POSITIVE if the value passes through HTML-escape (Encode.forHtml, ESAPI.encoder, HtmlUtils.htmlEscape, Apache StringEscapeUtils.escapeHtml).\n" +
      "3. FALSE_POSITIVE if the value is a class constant, env var, or static config — no request input upstream.\n" +
      "4. FALSE_POSITIVE if response.setContentType is application/json AND no script-execution context applies.",
    cwe: "CWE-79",
    fix_template:
      "Escape before writing: response.getWriter().write(org.owasp.encoder.Encode.forHtml(value));",
  },

  // ── Command injection broad: exec / ProcessBuilder with var (CWE-78) ─
  {
    id: "java-031-cmdi-exec-non-literal",
    title: "Runtime.exec / ProcessBuilder receives a non-literal argument",
    severity: "high",
    languages: ["java"],
    regex:
      /\b(?:(?:java\.lang\.)?Runtime\.getRuntime\s*\(\s*\)\s*\.\s*exec|\b\w+\s*\.\s*exec(?=\s*\(\s*[^"`'])|new\s+(?:java\.lang\.)?ProcessBuilder)\s*\(\s*(?!(?:"|`|'|new\s+String\s*\[\s*\]\s*\{\s*"))/g,
    explanation:
      "exec() / ProcessBuilder() is invoked with a non-literal argument. If any concatenated value or array element traces back to request input, the user can inject shell metacharacters or extra args. CWE-78.",
    verify_prompt:
      "Trace each argument component back to its definition.\n" +
      "1. CONFIRMED if any leads to request.getParameter / getHeader / getCookies and isn't strictly validated.\n" +
      "2. FALSE_POSITIVE if input passes through Pattern.matches against ^[a-zA-Z0-9_.-]+$ or similar anchored allow-list.\n" +
      "3. FALSE_POSITIVE if input is parsed to a numeric or enum type first and only the parsed value is used.\n" +
      "4. FALSE_POSITIVE if the args are all class constants / env vars / static config.",
    cwe: "CWE-78",
    fix_template:
      "Use ProcessBuilder with a validated args list (no concat) or whitelist input via Pattern.matches.",
  },

  // ── Path traversal broad: File / Paths constructed from var (CWE-22) ─
  {
    id: "java-032-path-file-non-literal",
    title: "File / Path constructed from a non-literal value",
    severity: "high",
    languages: ["java"],
    regex:
      /\b(?:new\s+(?:java\.io\.)?(?:File|FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile)\s*\(|(?:java\.nio\.file\.)?Files\.(?:newInputStream|newOutputStream|newBufferedReader|newBufferedWriter|readString|readAllBytes|write|copy|move|delete|exists)\s*\(|(?:java\.nio\.file\.)?Paths\.get\s*\()\s*(?!(?:"|`|'))/g,
    explanation:
      "File / Files / Paths constructor receives a non-literal argument. If the value traces back to request input without canonicalization + base-dir check, the user can read/write arbitrary paths via `..` traversal. CWE-22.",
    verify_prompt:
      "Trace the argument back to its definition.\n" +
      "1. CONFIRMED if any source is request.getParameter / getHeader / getCookies / getRequestURI without getCanonicalPath() startsWith() check.\n" +
      "2. FALSE_POSITIVE if input passes through Path.normalize() AND a startsWith(baseDir) check.\n" +
      "3. FALSE_POSITIVE if input is matched against a strict allow-list (e.g., Pattern.matches with no slashes/dots).\n" +
      "4. FALSE_POSITIVE if input is a class constant / env var / config.",
    cwe: "CWE-22",
    fix_template:
      "Canonicalize and verify: Path resolved = baseDir.resolve(input).normalize(); if (!resolved.startsWith(baseDir)) throw new SecurityException();",
  },

  // ── LDAP injection broad: search with non-literal filter (CWE-90) ─
  {
    id: "java-033-ldap-non-literal",
    title: "DirContext.search receives a non-literal LDAP filter",
    severity: "high",
    languages: ["java"],
    regex: /\.\s*(?:search|searchSubtree)\s*\(\s*[^,]+,\s*(?!(?:"|`|'))/g,
    explanation:
      "DirContext.search() is called with a non-literal filter argument. If the value contains user input without LDAP escaping, the attacker can inject LDAP operators (`*)(uid=*` etc.) to bypass authentication. CWE-90.",
    verify_prompt:
      "Trace the filter argument back to its definition.\n" +
      "1. CONFIRMED if any source is request input (getParameter / getHeader / getCookies) without LDAP escaping.\n" +
      "2. FALSE_POSITIVE if escaped via ESAPI.encoder().encodeForLDAP, manual escape of *()\\\\NUL chars, or Encode.forLDAP.\n" +
      "3. FALSE_POSITIVE if input is matched against a strict allow-list before the search call.",
    cwe: "CWE-90",
    fix_template: "Escape per RFC 4515 before search: String escaped = Encode.forLDAP(userInput);",
  },

  // ── Trust boundary broad: any setAttribute with non-literal val (CWE-501) ─
  {
    id: "java-034-trustbound-setattribute",
    title: "session.setAttribute with non-literal value (potential trust-boundary violation)",
    severity: "medium",
    languages: ["java"],
    regex:
      /\b(?:request\.)?getSession\s*\([^)]*\)\s*\.\s*setAttribute\s*\(\s*[^,]+,\s*(?!(?:"|`|'|null|true|false|\d+))/g,
    explanation:
      "An HttpSession attribute is being set to a non-literal value. If that value traces back to request input without parsing/validation, downstream code that reads the attribute will trust the value as a server-side derivation when in fact the user controls it. CWE-501.",
    verify_prompt:
      "Trace the value back to its definition.\n" +
      "1. CONFIRMED if value comes from request.* without parsing / validation.\n" +
      "2. FALSE_POSITIVE if value is a parsed type (int / enum / Date) where parsing rejects unsafe input.\n" +
      "3. FALSE_POSITIVE if value is a server-derived object (DAO query result, computed metric, auth-server claim).\n" +
      "4. FALSE_POSITIVE if a strict allow-list (Pattern.matches) ran upstream.",
    cwe: "CWE-501",
    fix_template:
      'Parse to a strict type before setAttribute: int userId = Integer.parseInt(input); session.setAttribute("userId", userId);',
  },

  // ── XSS via response.setHeader / addHeader (CWE-79 / CWE-113) ──
  // OWASP Benchmark v1.2 has 45 xss cases that route the tainted
  // value into a header (X-XSS-Protection variants, custom headers)
  // rather than the body. Header injection becomes XSS in browsers
  // that reflect the header value into a page (or directly via
  // CRLF injection in the value). v2.10.402.
  {
    id: "java-035-xss-header-non-literal",
    title: "response.setHeader / addHeader with a non-literal value",
    severity: "high",
    languages: ["java"],
    regex: /\bresponse\.(?:setHeader|addHeader)\s*\(\s*"[^"]+"\s*,\s*(?!(?:"|`|'|null|\d+\s*\)))/g,
    explanation:
      "response.setHeader / addHeader is called with a non-literal value as the second argument. If that value traces back to request input without strict allow-list validation, the user can inject CRLF bytes (response splitting), write a Set-Cookie they shouldn't be able to set, or land arbitrary content in a header that's reflected into the page. CWE-79 / CWE-113.",
    verify_prompt:
      "Trace the second argument back to its definition.\n" +
      "1. CONFIRMED if any source is request.getParameter / getHeader / getCookies / getRequestURI without strict allow-list parsing.\n" +
      "2. FALSE_POSITIVE if the value is a parsed type (int, enum, UUID) or matches an anchored allow-list regex.\n" +
      "3. FALSE_POSITIVE if the header name is one that the framework strips of CRLF (`Content-Type` is generally container-validated; custom headers are not).",
    cwe: "CWE-79",
    fix_template:
      'Validate before setting: if (Pattern.matches("^[A-Za-z0-9_-]+$", value)) response.setHeader("X-Custom", value);',
  },

  // ── XSS via bound PrintWriter variable (CWE-79) ─────────────────
  // OWASP shape: `PrintWriter out = response.getWriter(); ...
  // out.format(Locale.US, fmt, obj);` — same xss as java-030 but
  // the writer is held in a local variable, so the regex anchored
  // on `response.getWriter()...` doesn't match. Captures the var
  // name with `(\w+)` and re-uses it later via `\1` to find the
  // sink call. v2.10.404.
  {
    id: "java-036-xss-printwriter-var",
    title: "PrintWriter from response.getWriter() used as a sink (var-flow)",
    severity: "high",
    languages: ["java"],
    regex:
      /\b(?:java\.io\.)?PrintWriter\s+(\w+)\s*=\s*response\.getWriter\s*\(\s*\)\s*;[\s\S]{0,400}?\b\1\s*\.\s*(?:print|println|printf|write|format|append)\s*\(/g,
    explanation:
      "A PrintWriter obtained from response.getWriter() is being written to with a non-literal first argument. The variable assignment + later sink call is the same xss shape java-030 handles for the inline form; this catches it when the writer is held in a local variable. CWE-79.",
    verify_prompt:
      "Trace the first argument of the print/println/printf/write/format call.\n" +
      "1. CONFIRMED if any source path leads to request.getParameter / getHeader / getCookies / getRequestURI.\n" +
      "2. FALSE_POSITIVE if all path values pass through HTML-encode (Encode.forHtml, ESAPI.encoder, HtmlUtils.htmlEscape, Apache StringEscapeUtils.escapeHtml).\n" +
      "3. FALSE_POSITIVE if the value is a class constant or static config — no request input upstream.",
    cwe: "CWE-79",
    fix_template: "Encode before writing: out.write(org.owasp.encoder.Encode.forHtml(value));",
  },
];
