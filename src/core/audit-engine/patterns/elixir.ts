// KCode - ELIXIR Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const ELIXIR_PATTERNS: BugPattern[] = [
  {
    id: "ex-001-atom-from-user-input",
    title: "Atom creation from user input (atom table exhaustion)",
    severity: "high",
    languages: ["elixir"],
    regex: /\bString\.to_atom\s*\(/g,
    explanation:
      "String.to_atom() creates atoms that are never garbage collected. If called with user input, attackers can exhaust the atom table (default limit: 1,048,576) and crash the BEAM VM.",
    verify_prompt:
      "Is the string from user/external input (request params, API data, form fields)? " +
      "If from internal constants or compile-time config, respond FALSE_POSITIVE. " +
      "If from untrusted input, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use String.to_existing_atom() which only converts already-existing atoms, or keep as string.",
  },
  {
    id: "ex-002-to-atom-untrusted",
    title: "String.to_atom with untrusted data",
    severity: "high",
    languages: ["elixir"],
    regex: /\bString\.to_atom\s*\(\s*(?:params|conn\.|request|input|body|data)/g,
    explanation:
      "String.to_atom() with request/user data is a denial-of-service vector. Each unique string creates a new permanent atom in the BEAM VM.",
    verify_prompt:
      "Is the argument from user input (Phoenix params, Plug conn, API body)? " +
      "If from internal/compile-time source, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use String.to_existing_atom() or keep the value as a string. Map strings to atoms with a whitelist.",
  },
  {
    id: "ex-003-unbounded-mailbox",
    title: "GenServer without backpressure (unbounded mailbox)",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bGenServer\.cast\s*\([^)]*\)[\s\S]{0,500}?(?!handle_info.*:check_mailbox|Process\.info.*:message_queue_len)/g,
    explanation:
      "GenServer.cast() is fire-and-forget. If messages arrive faster than the server processes them, the mailbox grows unbounded until the VM runs out of memory.",
    verify_prompt:
      "Is this GenServer under a high message rate (e.g., receiving events from many sources)? " +
      "If it's a low-rate administrative GenServer, respond FALSE_POSITIVE. " +
      "If it could receive bursts of messages without backpressure, respond CONFIRMED.",
    cwe: "CWE-770",
    fix_template: "Use GenServer.call() for backpressure, or monitor mailbox size with Process.info(self(), :message_queue_len).",
  },
  {
    id: "ex-004-ets-race-condition",
    title: "ETS read-modify-write without transaction",
    severity: "medium",
    languages: ["elixir"],
    regex: /\b:ets\.lookup\s*\([^)]*\)[\s\S]{0,200}?:ets\.insert\s*\(/g,
    explanation:
      "ETS lookup followed by insert is not atomic. Concurrent processes can read stale data, compute based on it, and overwrite each other's updates (lost update race).",
    verify_prompt:
      "Is this ETS table accessed by multiple processes concurrently? " +
      "If it's a single-writer table or protected by a GenServer serializing access, respond FALSE_POSITIVE. " +
      "If multiple processes read-modify-write, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use :ets.update_counter() for atomic increments, or serialize access through a GenServer.",
  },
  {
    id: "ex-005-process-exit-kill",
    title: "Process.exit(:kill) misuse",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bProcess\.exit\s*\([^,)]+,\s*:kill\s*\)/g,
    explanation:
      "Process.exit(pid, :kill) sends an untrappable exit signal. The target process cannot run cleanup code (terminate/2 callback). This can leave resources (files, sockets, ETS tables) in an inconsistent state.",
    verify_prompt:
      "Is :kill used as a last resort after a normal shutdown attempt, or is it the primary shutdown mechanism? " +
      "If it's a fallback after timeout on normal exit, respond FALSE_POSITIVE. " +
      "If it's the first/only shutdown signal, respond CONFIRMED.",
    cwe: "CWE-404",
    fix_template: "Use Process.exit(pid, :shutdown) first, which allows cleanup. Only use :kill as a timeout fallback.",
  },
  {
    id: "ex-006-ecto-raw-sql-injection",
    title: "SQL injection in Ecto raw query",
    severity: "critical",
    languages: ["elixir"],
    regex: /\bEcto\.Adapters\.\w+\.query\s*\(\s*\w+\s*,\s*"[^"]*#\{/g,
    explanation:
      "String interpolation in Ecto raw SQL queries bypasses parameterization. User input in the interpolated expression enables SQL injection.",
    verify_prompt:
      "Does the #{} interpolation contain user input (params, conn.params, form data)? " +
      "If interpolating a module constant or compile-time value, respond FALSE_POSITIVE. " +
      "If user-controlled data, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: 'Use parameterized queries: Ecto.Adapters.SQL.query(repo, "SELECT * FROM t WHERE id = $1", [user_id])',
  },
  {
    id: "ex-007-hardcoded-secrets-config",
    title: "Hardcoded secrets in config",
    severity: "high",
    languages: ["elixir"],
    regex: /(?:secret_key_base|api_key|password|secret|token):\s*"[A-Za-z0-9+/=_-]{16,}"/g,
    explanation:
      "Hardcoded secrets in config.exs or runtime.exs are committed to version control. Use environment variables or vault.",
    verify_prompt:
      "Is this in a config file committed to git (config.exs, dev.exs, prod.exs)? " +
      "If it's in runtime.exs reading from System.get_env(), respond FALSE_POSITIVE. " +
      "If the secret is a hardcoded literal in a committed config, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: 'Use System.get_env("SECRET_KEY_BASE") in runtime.exs.',
  },
  {
    id: "ex-008-missing-supervisor-strategy",
    title: "Supervisor without explicit restart strategy",
    severity: "low",
    languages: ["elixir"],
    regex: /\bSupervisor\.start_link\s*\(\s*\[[^\]]*\]\s*,\s*(?:name:|strategy:(?!\s*:one_for_one|\s*:rest_for_one|\s*:one_for_all))/g,
    explanation:
      "Using the default supervisor strategy without explicit thought can lead to cascading failures. The default :one_for_one may not be appropriate for processes with dependencies.",
    verify_prompt:
      "Is the default :one_for_one strategy appropriate for these child processes? " +
      "If the children are independent, respond FALSE_POSITIVE. " +
      "If children depend on each other (e.g., producer-consumer), respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Explicitly set strategy: Supervisor.start_link(children, strategy: :one_for_all) for dependent processes.",
  },
  {
    id: "ex-009-task-async-no-await",
    title: "Task.async without Task.await (orphaned task)",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bTask\.async\s*\([^)]*\)(?![\s\S]{0,300}?Task\.(?:await|yield))/g,
    explanation:
      "Task.async() creates a linked task that MUST be awaited. If never awaited, the caller process will crash when the task finishes or times out (default 5 seconds).",
    verify_prompt:
      "Is Task.await() or Task.yield() called on this task within the same function or scope? " +
      "If awaited, respond FALSE_POSITIVE. " +
      "If the task result is never collected, respond CONFIRMED.",
    cwe: "CWE-404",
    fix_template: "Add Task.await(task) to collect the result, or use Task.start/Task.start_link for fire-and-forget.",
  },
  {
    id: "ex-010-io-inspect-production",
    title: "IO.inspect left in production code",
    severity: "low",
    languages: ["elixir"],
    regex: /\bIO\.inspect\s*\(/g,
    explanation:
      "IO.inspect() is a debugging tool that writes to stdout. In production, it can leak sensitive data to logs, and the synchronous I/O impacts performance under load.",
    verify_prompt:
      "Is this IO.inspect in production code or in test/development helpers? " +
      "If in test files, IEx helpers, or behind a debug flag, respond FALSE_POSITIVE. " +
      "If in production code path (controllers, contexts, GenServers), respond CONFIRMED.",
    cwe: "CWE-532",
    fix_template: "Use Logger.debug(inspect(value)) for structured logging, or remove the IO.inspect call.",
  },
];
