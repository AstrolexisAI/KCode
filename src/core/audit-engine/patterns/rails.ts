// KCode - Rails framework pack (P2.3, v2.10.391)
//
// Rails-specific bug shapes complementing the existing
// rails-001-html-safe in framework.ts. Same `pack: "web"` tag.

import type { BugPattern } from "../types";

export const RAILS_PATTERNS: BugPattern[] = [
  {
    id: "rails-002-send-to-dynamic-method",
    title: "send/public_send with user-controlled method name — RCE primitive",
    severity: "critical",
    languages: ["ruby"],
    pack: "web",
    // .send(params[:x]) / .public_send(params[:x]) / object.send(method)
    // where method comes from params/request.
    regex: /\b\.(?:send|public_send|__send__)\s*\(\s*(?:[^)]*?\bparams\[|[^)]*?\brequest\.(?:params|GET|POST))/g,
    explanation:
      "Ruby's send/public_send invokes ANY method on the receiver by name. With a user-controlled method name the caller picks the method — including dangerous ones like `system`, `eval`, `instance_eval`, or removing every record. Rails' params hash regularly carries un-validated strings, so `User.find(1).send(params[:method])` is an RCE primitive disguised as ergonomic dispatch. Real incidents: GitHub's 2012 mass-assignment, several DHH-era Rails apps.",
    verify_prompt:
      "Is the method name actually user-controlled?\n" +
      "1. The argument flows from params / request.params / request.GET / request.POST — CONFIRMED.\n" +
      "2. The argument is matched against an allowlist BEFORE send (`%w[a b c].include?(name)`) — FALSE_POSITIVE.\n" +
      "3. The argument is hardcoded — FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Replace dynamic dispatch with a case statement listing every allowed method explicitly. If you genuinely need a method-by-name lookup, use a hash `ALLOWED = { 'sort' => :sort, ... }; method = ALLOWED[params[:m]] or raise` so unknown values fail fast.",
  },
  {
    id: "rails-003-mass-assignment",
    title: "params.permit! or controller without strong params",
    severity: "high",
    languages: ["ruby"],
    pack: "web",
    // Match params.permit! (without args — wildcard permit) or
    // User.update(params[:user]) without a permit call.
    regex: /\bparams\.permit!|\b(?:update|update_attributes|create|new|attributes\s*=)\s*\(\s*params\[/g,
    explanation:
      "Mass assignment ships in Rails apps that use the legacy `update_attributes(params[:user])` pattern (whitelisting nothing) or `params.permit!` (whitelisting everything). An attacker submits a form with `user[admin]=true` or `user[role]=owner` and the model sets the attribute. The 2012 GitHub-on-Rails incident gave an attacker push access to rails/rails via this exact shape.",
    verify_prompt:
      "Is the parameter set actually whitelisted?\n" +
      "1. `params.permit!` (with bang, no args) — CONFIRMED.\n" +
      "2. `User.update(params[:user])` without a require/permit chain — CONFIRMED.\n" +
      "3. `params.require(:user).permit(:name, :email)` is used — FALSE_POSITIVE.\n" +
      "4. The form is purely admin-only and the auth layer enforces that — borderline; CONFIRMED unless explicit role check is visible in scope.",
    cwe: "CWE-915",
    fix_template:
      "Replace with strong params: `params.require(:user).permit(:name, :email)` — list every attribute the form should be allowed to set. NEVER use params.permit! — it whitelists EVERY field including admin/role/sensitive flags.",
  },
  {
    id: "rails-004-eval-instance-eval",
    title: "eval / instance_eval / class_eval with dynamic content",
    severity: "critical",
    languages: ["ruby"],
    pack: "web",
    regex: /\b(?:eval|instance_eval|class_eval|module_eval)\s*\(\s*(?:[^)]*?\bparams\[|[^)]*?\brequest\.|[^)]*?#\{)/g,
    explanation:
      "Ruby's eval-family methods run arbitrary Ruby code. With user input — params, request, or string-interpolated `\"...#{user_input}...\"` — the caller gets full process access. instance_eval and class_eval are even worse because they run in the receiver's context, so attackers can monkey-patch the model layer.",
    verify_prompt:
      "Is the eval argument attacker-reachable?\n" +
      "1. Argument includes params / request / interpolated user data — CONFIRMED.\n" +
      "2. Argument is a hardcoded constant — FALSE_POSITIVE.\n" +
      "3. The eval is in a Rake task / migration / never reached from the web — FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template:
      "Don't use eval. For DSLs, use a structured DSL (Liquid, Hash) with explicit dispatch. For dynamic method invocation, use case statements with allowlists.",
  },
  {
    id: "rails-005-render-inline",
    title: "render inline: with dynamic content — ERB injection",
    severity: "critical",
    languages: ["ruby"],
    pack: "web",
    // render inline: "...#{...}..." OR render inline: params[:tpl]
    regex: /\brender\s+(?:.*,\s*)?inline:\s*(?:["'][^"']*#\{|params\[|@\w+(?:\s*\+|\s*<<))/g,
    explanation:
      "render inline: takes a string template and renders it as ERB. With user input in the template, the attacker can write arbitrary ERB tags `<%= system('rm -rf /') %>` and the framework executes them server-side. ERB injection is RCE-equivalent in Rails.",
    verify_prompt:
      "Does the inline template incorporate user input?\n" +
      "1. The template string includes `#{...}` interpolation OR params[:...] OR a concatenated user-controlled @var — CONFIRMED.\n" +
      "2. The template is a hardcoded string with no interpolation — FALSE_POSITIVE.",
    cwe: "CWE-94",
    fix_template:
      "Don't use inline templates with user input. Use a partial (`render 'shared/something'`) and pass user data through `locals: { ... }`, which is HTML-escaped. If you need a dynamic template, store it server-side and reference by ID.",
  },
];
