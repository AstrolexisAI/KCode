// KCode - LUA Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const LUA_PATTERNS: BugPattern[] = [
  {
    id: "lua-001-global-pollution",
    title: "Global variable pollution (missing local)",
    severity: "medium",
    languages: ["lua"],
    regex: /^(?!\s*local\s)\s*([a-zA-Z_]\w*)\s*=\s*(?!nil\b)/gm,
    explanation:
      "Variables without 'local' keyword are global in Lua, polluting the global namespace. This causes hard-to-debug name collisions across modules and files.",
    verify_prompt:
      "Is this an intentional global assignment (module export, configuration table)? " +
      "If it's a module-level export or in the main script, respond FALSE_POSITIVE. " +
      "If it's inside a function and should be local, respond CONFIRMED.",
    cwe: "CWE-1108",
    fix_template: "Add 'local' keyword: local myVar = value",
  },
  {
    id: "lua-002-loadstring-injection",
    title: "loadstring/load with user input (code injection)",
    severity: "critical",
    languages: ["lua"],
    regex: /\b(?:loadstring|load)\s*\(\s*(?!["'])[a-zA-Z_]/g,
    explanation:
      "loadstring()/load() compiles and returns a Lua function from a string. With user input, attackers can execute arbitrary Lua code including os.execute(), io.open(), etc.",
    verify_prompt:
      "Is the string argument from user/external input (network, file, config)? " +
      "If it's a hardcoded string literal, respond FALSE_POSITIVE. " +
      "If the string could contain untrusted data, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Avoid loadstring with user data. Use a data format (JSON) and parse it instead.",
  },
  {
    id: "lua-003-table-nil-index",
    title: "Table indexed with potentially nil key",
    severity: "medium",
    languages: ["lua"],
    regex: /\b(\w+)\s*\[\s*(\w+)\s*\]\s*=(?![\s\S]{0,50}?if\s+\2\s*~=\s*nil)/g,
    explanation:
      "Indexing a table with nil crashes Lua: 'table index is nil'. This commonly happens when a variable is uninitialized or a function returns nil unexpectedly.",
    verify_prompt:
      "Is the index variable guaranteed to be non-nil at this point? " +
      "If there's a preceding nil check or the variable is always set, respond FALSE_POSITIVE. " +
      "If the index could be nil (from function return, optional parameter), respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Add nil guard: if key ~= nil then tbl[key] = value end",
  },
  {
    id: "lua-004-string-concat-loop",
    title: "String concatenation in loop (O(n^2) performance)",
    severity: "low",
    languages: ["lua"],
    regex: /(?:for|while)\s+[\s\S]{0,100}?\b(\w+)\s*=\s*\1\s*\.\.\s*/g,
    explanation:
      "Lua strings are immutable. Concatenating with .. in a loop creates a new string each iteration, causing O(n^2) memory allocation. Use table.concat instead.",
    verify_prompt:
      "Is this string concatenation inside a loop that could iterate many times? " +
      "If the loop iterates a fixed small number of times (< 10), respond FALSE_POSITIVE. " +
      "If it processes variable-length data (file lines, records), respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template:
      "Collect in table, join at end: local parts = {}; for ... do parts[#parts+1] = chunk end; result = table.concat(parts)",
  },
  {
    id: "lua-005-os-execute-injection",
    title: "os.execute with user input (command injection)",
    severity: "critical",
    languages: ["lua"],
    regex: /\bos\.execute\s*\(\s*(?!["'])[a-zA-Z_]/g,
    explanation:
      "os.execute() runs a shell command. If the argument includes user input, attackers can inject additional commands with ; | && etc.",
    verify_prompt:
      "Is the command string from user/external input or constructed with user data? " +
      "If entirely hardcoded, respond FALSE_POSITIVE. " +
      "If user input is concatenated into the command, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template:
      "Avoid os.execute with user data. Use io.popen with proper escaping, or avoid shell entirely.",
  },
  {
    id: "lua-006-pcall-no-error-handling",
    title: "pcall result ignored (silent error swallowing)",
    severity: "medium",
    languages: ["lua"],
    regex: /\bpcall\s*\([^)]*\)\s*\n\s*(?!(?:if|local\s+\w+\s*,\s*\w+))/g,
    explanation:
      "pcall() returns success boolean and result/error, but if the return values are ignored, errors are silently swallowed. This hides bugs and makes debugging difficult.",
    verify_prompt:
      "Are the pcall return values (ok, err) captured and checked? " +
      "If the result is assigned and checked, respond FALSE_POSITIVE. " +
      "If pcall is called as a statement with no return value capture, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "local ok, err = pcall(fn); if not ok then log_error(err) end",
  },
  {
    id: "lua-007-infinite-coroutine",
    title: "Infinite loop without yield in coroutine",
    severity: "high",
    languages: ["lua"],
    regex:
      /coroutine\.create\s*\(\s*function[\s\S]{0,200}?while\s+true\s+do(?![\s\S]{0,200}?coroutine\.yield)/g,
    explanation:
      "A coroutine with while-true and no yield will never return control to the caller, effectively hanging the program.",
    verify_prompt:
      "Does this while-true loop inside the coroutine contain a coroutine.yield()? " +
      "If yield exists within the loop body, respond FALSE_POSITIVE. " +
      "If the loop has no yield or break, respond CONFIRMED.",
    cwe: "CWE-835",
    fix_template: "Add coroutine.yield() inside the loop to return control to the caller.",
  },
  {
    id: "lua-008-require-path-injection",
    title: "require() with user input (path injection)",
    severity: "high",
    languages: ["lua"],
    regex: /\brequire\s*\(\s*(?!["'])[a-zA-Z_]\w*\s*\)/g,
    explanation:
      "require() with a variable module name allows attackers to load arbitrary Lua modules. Combined with package.path manipulation, this can execute attacker-controlled code.",
    verify_prompt:
      "Is the module name from user/external input or a dynamic variable? " +
      "If it's an internal variable set from a trusted whitelist, respond FALSE_POSITIVE. " +
      "If it could be user-controlled, respond CONFIRMED.",
    cwe: "CWE-98",
    fix_template:
      "Whitelist modules: local ALLOWED = {mod1=true, mod2=true}; if ALLOWED[name] then require(name) end",
  },
];
