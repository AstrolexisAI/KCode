// KCode - Laravel framework pack (P2.3, v2.10.391)
//
// Laravel-specific bug shapes. Same `pack: "web"` tag.

import type { BugPattern } from "../types";

export const LARAVEL_PATTERNS: BugPattern[] = [
  {
    id: "laravel-001-mass-assignment-fillable-empty",
    title: "Eloquent model::create()/fill() with $request->all() and no $fillable",
    severity: "high",
    languages: ["php"],
    pack: "web",
    // ::create($request->all()) / ->fill($request->all()) — the
    // `all()` form takes EVERY field. Without a $fillable allowlist
    // on the model, the assignment goes through.
    regex: /\b(?:::create|->fill|->update|::firstOrCreate|::updateOrCreate)\s*\(\s*\$request->all\s*\(\s*\)/g,
    explanation:
      "Laravel's $request->all() returns every input the user submitted. Passing it to Model::create()/fill() lets the user set any column the model exposes — including admin / role / is_verified flags. The standard Laravel guidance is to set $fillable on every model; apps that skip that AND use ->all() ship mass-assignment vulnerabilities by default. CVE-2018-15133 (Laravel APP_KEY) was the high-profile incident, but the per-app shape recurs constantly.",
    verify_prompt:
      "Does the target model declare $fillable / $guarded restricting the columns?\n" +
      "1. Model has a $fillable list and the columns NOT in $fillable are sensitive (admin, role, etc.) — FALSE_POSITIVE; Laravel ignores unlisted columns.\n" +
      "2. Model has $guarded = [] (whitelist all) — CONFIRMED. This explicitly disables protection.\n" +
      "3. No $fillable / $guarded declared AND the model has sensitive columns — CONFIRMED.\n" +
      "4. Cannot determine the model's $fillable from the snippet — NEEDS_CONTEXT.",
    cwe: "CWE-915",
    fix_template:
      "Replace `$request->all()` with `$request->only(['name', 'email'])` — list every column the form should set. Add a $fillable to the model as a backstop. Never use `$guarded = []`.",
  },
  {
    id: "laravel-002-eval-of-request",
    title: "eval() with request input — RCE",
    severity: "critical",
    languages: ["php"],
    pack: "web",
    regex: /\beval\s*\(\s*[^)]*?\$(?:request|_GET|_POST|_REQUEST|_COOKIE)/g,
    explanation:
      "PHP's eval runs an arbitrary string as code. With $request / $_GET / $_POST / $_COOKIE / $_REQUEST as the source, the attacker writes the code. There is no scenario where this is the right primitive in a web request handler.",
    verify_prompt:
      "Is the eval argument attacker-reachable?\n" +
      "1. Argument flows from $request / $_GET / $_POST / $_REQUEST / $_COOKIE — CONFIRMED.\n" +
      "2. Argument is a hardcoded constant — FALSE_POSITIVE.\n" +
      "3. Pattern is in a fixture / test — FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Don't eval. For math, use a safe expression library. For dynamic logic, dispatch on a hardcoded enum / case. For data, use json_decode + a validator.",
  },
  {
    id: "laravel-003-raw-db-query-with-input",
    title: "DB::raw / DB::statement / DB::select with user input concatenated",
    severity: "critical",
    languages: ["php"],
    pack: "web",
    // DB::raw("... $request->... ...") OR DB::statement / DB::select
    // with string concatenation of $request data.
    regex: /\bDB::(?:raw|statement|select|insert|update|delete)\s*\(\s*["'][^"']*?(?:\$\w+|\.\s*\$\w+|\$request)/g,
    explanation:
      "Laravel's DB facade has two forms: parameterized (`DB::select('select * from x where y = ?', [$id])`) and raw (`DB::raw(\"... $userInput\")`). Concatenating $request data into the SQL string bypasses Eloquent's binding logic and produces SQL injection.",
    verify_prompt:
      "Is the SQL string built with user-controlled data?\n" +
      "1. The query string includes `$request->...` / `$_GET[...]` / interpolated user data via `$var` — CONFIRMED.\n" +
      "2. The query uses placeholder `?` AND the binding array contains user data — FALSE_POSITIVE; the binding layer escapes.\n" +
      "3. The variable is type-cast to int (`(int) $request->id`) before interpolation — borderline FALSE_POSITIVE for integer columns.",
    cwe: "CWE-89",
    fix_template:
      "Use parameterized queries: `DB::select('select * from users where id = ?', [$request->id])`. For the QueryBuilder, use `->where('id', $request->id)` (binds automatically). Reserve DB::raw for static SQL only.",
  },
];
