// KCode - Deserialization / Object-Injection Patterns
//
// Untrusted deserialization is consistently in the OWASP Top 10.
// Most of these patterns target language features that are documented
// as dangerous-by-default but still widely used because of inertia.

import type { BugPattern } from "../types";

export const DESERIALIZE_PATTERNS: BugPattern[] = [
  // ── pickle on untrusted data ────────────────────────────────────
  {
    id: "des-001-pickle-loads",
    title: "pickle.loads / cPickle on untrusted data",
    severity: "critical",
    languages: ["python"],
    regex:
      /\b(?:pickle|cPickle|_pickle|dill|cloudpickle|pathos)\.(?:loads?|Unpickler)\s*\(/g,
    explanation:
      "Python's pickle is Turing-complete deserialization. Any attacker-controlled pickle blob gives remote code execution via `__reduce__` payloads. Python docs explicitly say: `Never unpickle data received from an untrusted or unauthenticated source.`",
    verify_prompt:
      "Is the pickle input data from an untrusted source (network request, user-uploaded file, database field stored from a request)? If it's an internal-only path — loading a known-trusted model checkpoint, IPC between your own processes, a cache you yourself wrote — FALSE_POSITIVE. If the blob could be attacker-controlled, CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Switch to JSON / msgpack / protobuf. If pickle is unavoidable, sign the blob with HMAC and verify before loading.",
  },

  // ── yaml.load without Loader ────────────────────────────────────
  {
    id: "des-002-yaml-full-load",
    title: "yaml.load / load_all without SafeLoader",
    severity: "critical",
    languages: ["python"],
    regex:
      /\byaml\.(?:load|load_all)\s*\([^)]*\)(?![\s\S]*?Loader\s*=\s*(?:yaml\.)?Safe(?:Loader)?)/g,
    explanation:
      "PyYAML's default loader supports `!!python/object/apply:os.system` tags → RCE on parsing. The library deprecated the default unsafe behavior in 2020 but many codebases still call `yaml.load(...)` without specifying Loader. CVE-2017-18342.",
    verify_prompt:
      "Does the call include `Loader=SafeLoader` or `Loader=yaml.SafeLoader`? The default without Loader IS unsafe in older versions and emits a warning in newer ones. If SafeLoader is used OR the call is `yaml.safe_load(...)`, FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template:
      "Replace `yaml.load(x)` with `yaml.safe_load(x)` or `yaml.load(x, Loader=yaml.SafeLoader)`.",
  },

  // ── eval / exec with input ──────────────────────────────────────
  {
    id: "des-003-eval-user-input",
    title: "eval / exec / Function / new Function with user input",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "ruby", "php"],
    regex:
      /\b(?:eval|exec|execfile|compile|Function\s*\(\s*['"`]|new\s+Function\s*\(|setTimeout\s*\(\s*['"`][^'"`]*\$\{)\s*\([^)]*(?:request|params|body|user|input|args|argv)\b/gi,
    explanation:
      "eval/exec on user input is full RCE. setTimeout/setInterval/Function/new Function with a string argument is an alias for eval. Even `compile(user_str)` loads attacker code into Python's interpreter state.",
    verify_prompt:
      "Is the eval/exec argument user-controllable? If the argument is a hardcoded string or a value from a trust-boundary-safe source (internal config file you ship, a computed constant), FALSE_POSITIVE. If it's request/input/argv data, CONFIRMED.",
    cwe: "CWE-95",
    fix_template:
      "Use ast.literal_eval (Python) or JSON.parse (JS) for data literals. Build a domain-specific parser for anything else.",
  },

  // ── Java ObjectInputStream without filter ───────────────────────
  {
    id: "des-004-java-objectinputstream",
    title: "Java ObjectInputStream without serialization filter",
    severity: "critical",
    languages: ["java"],
    regex:
      /\bnew\s+ObjectInputStream\s*\([^)]*\)(?![\s\S]*?setObjectInputFilter)/g,
    explanation:
      "Java ObjectInputStream deserializes any serializable class on the classpath — including Commons Collections gadget chains that chain into RCE. Fixed in JEP 290 (Java 9) via ObjectInputFilter, but codebases rarely set one.",
    verify_prompt:
      "Is setObjectInputFilter called on this stream (before any readObject()) or globally via ObjectInputFilter.Config.setSerialFilter? If yes, FALSE_POSITIVE. If the stream is constructed raw and used, CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Set a class allowlist: `ois.setObjectInputFilter(filter);` where filter rejects gadget classes. Better: stop using Java serialization, switch to Jackson with explicit types.",
  },

  // ── PHP unserialize ─────────────────────────────────────────────
  {
    id: "des-005-php-unserialize",
    title: "PHP unserialize on user-controllable data",
    severity: "critical",
    languages: ["php"],
    regex:
      /\bunserialize\s*\(\s*\$(?:_POST|_GET|_REQUEST|_COOKIE|HTTP_)/gi,
    explanation:
      "PHP unserialize triggers __wakeup / __destruct on arbitrary classes, which combined with POP gadgets (Laravel, phpggc) gives RCE. CVE-2022-31625 (phpMyAdmin), CVE-2021-3618 (dozens more).",
    verify_prompt:
      "Is the data directly from a user request variable ($_POST/$_GET/$_COOKIE/$_REQUEST)? If yes, CONFIRMED. If it's a trusted-source value that was itself produced by serialize() within the same trust boundary (e.g. session storage signed by framework), FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template:
      "Use json_decode for untrusted input. If PHP serialize is required, sign the blob with hash_hmac and verify before unserialize.",
  },

  // ── Ruby YAML.load / Marshal.load ───────────────────────────────
  {
    id: "des-006-ruby-marshal",
    title: "Ruby Marshal.load / YAML.load on untrusted data",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:Marshal\.load|YAML\.load)\s*\(/g,
    explanation:
      "Ruby's Marshal can instantiate any object + call __ivar callbacks — gadget chains in ActiveSupport/ActionPack lead to RCE. YAML.load (without safe_load) has the same exposure via !ruby/object tags.",
    verify_prompt:
      "Is the load called on data that could come from an HTTP request, uploaded file, database field populated from a request, or cookie? If the input is trusted (internal config file, redis key written by same app), FALSE_POSITIVE. Untrusted → CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "YAML.safe_load for YAML. For anything else, use JSON.parse.",
  },

  // ── C# BinaryFormatter ──────────────────────────────────────────
  {
    id: "des-007-csharp-binaryformatter",
    title: "C# BinaryFormatter / NetDataContractSerializer on untrusted data",
    severity: "critical",
    languages: ["csharp"],
    regex:
      /\b(?:BinaryFormatter|NetDataContractSerializer|SoapFormatter|LosFormatter|ObjectStateFormatter)\s*\(\s*\)\s*\.\s*Deserialize/g,
    explanation:
      "Microsoft marked BinaryFormatter.Deserialize as a known RCE vector and plans to remove it. Every .NET gadget chain research (ysoserial.net) targets these serializers. CVE-2020-1147 (SharePoint).",
    verify_prompt:
      "Is the input stream from an untrusted source (web request, file upload, cookie, remoting endpoint)? If trusted (local process IPC, own database with signed content), FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Switch to System.Text.Json or Newtonsoft.Json with TypeNameHandling.None. If binary format is needed, protobuf-net or MessagePack-CSharp.",
  },

  // ── Node vm / safeEval misuse ───────────────────────────────────
  {
    id: "des-008-node-vm-runInThisContext",
    title: "Node vm.runInThisContext / runInNewContext with user code",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex:
      /\bvm\.(?:runInThisContext|runInNewContext|runInContext|compileFunction)\s*\(\s*(?:request|params|body|user|input|req\.)/gi,
    explanation:
      "Node's `vm` module is often misunderstood as a sandbox. It isn't — `this.constructor.constructor('return process')()` escapes any vm context and reaches process.mainModule. CVE-2019-10769 (express-fileupload context), CVE-2020-15366.",
    verify_prompt:
      "Is the code argument user-controllable? If it's a hardcoded template string and only context variables come from users, FALSE_POSITIVE. If user input reaches the first argument, CONFIRMED — even a sandboxed vm is not a security boundary against untrusted code.",
    cwe: "CWE-265",
    fix_template:
      "Don't run untrusted code. If you need a DSL, build a parser/evaluator for the specific language subset. For sandboxed execution, use isolated-vm with strict constraints.",
  },

  // ── Django / Flask pickle in session ────────────────────────────
  {
    id: "des-009-django-pickle-session",
    title: "Django SESSION_SERIALIZER or Flask session set to pickle",
    severity: "high",
    languages: ["python"],
    regex:
      /\b(?:SESSION_SERIALIZER\s*=\s*['"]django\.contrib\.sessions\.serializers\.PickleSerializer|SESSION_COOKIE_SERIALIZER\s*=\s*['"]pickle|app\.session_interface\s*=\s*.*Pickle)/g,
    explanation:
      "Configuring sessions to use pickle means any session-tampering vulnerability (weak secret, known-key leak) escalates to RCE via pickle payload in the cookie. Django's default is JSON since 1.6 specifically for this reason.",
    verify_prompt:
      "Is this setting active in the production config, or scoped to a test/dev environment? If it's in a test settings file, FALSE_POSITIVE. In main settings, CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Use the JSON serializer (Django default): `SESSION_SERIALIZER = 'django.contrib.sessions.serializers.JSONSerializer'`.",
  },

  // ── XML deserialization in .NET (XmlSerializer with XmlAnyElement)
  {
    id: "des-010-xml-type-resolver",
    title: "Jackson / XStream / .NET XML deserialization with type inference",
    severity: "high",
    languages: ["java", "csharp"],
    regex:
      /\b(?:enableDefaultTyping|activateDefaultTyping|XStream\s*\(\s*\)|new\s+XmlSerializer\s*\([^)]*Type(?:Filter)?Level\.Full|DataContractJsonSerializer.*KnownTypes)\b/g,
    explanation:
      "Jackson's `enableDefaultTyping` embeds type hints in JSON — an attacker can pin any class name, triggering its constructor on deserialize (CVE-2017-7525, hundreds of CVEs since). XStream has similar behavior by default. .NET XmlSerializer with Full-trust filter similarly trusts type names in the XML.",
    verify_prompt:
      "Does the code configure a type whitelist (PolymorphicTypeValidator in Jackson, XStream.allowTypes, [DataContract] with [KnownType] limited)? If explicit allowlist present, FALSE_POSITIVE. If default typing / full type resolution, CONFIRMED.",
    cwe: "CWE-502",
    fix_template:
      "Jackson: use activateDefaultTyping(PolymorphicTypeValidator) with a strict allowlist. XStream: xstream.addPermission(NoTypePermission.NONE) + explicit allowTypes.",
  },
];
