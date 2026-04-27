// KCode - Spring framework pack (P2.3, v2.10.391)
//
// Spring (Boot / MVC) specific bug shapes. Same `pack: "web"` tag.

import type { BugPattern } from "../types";

export const SPRING_PATTERNS: BugPattern[] = [
  {
    id: "spring-001-deserialization",
    title: "ObjectInputStream.readObject() — RCE via Java deserialization",
    severity: "critical",
    languages: ["java"],
    pack: "web",
    // ObjectInputStream + readObject() without a strict resolveClass
    // override. Match the readObject call after an ObjectInputStream
    // construction.
    regex: /\bnew\s+ObjectInputStream\s*\([\s\S]{0,300}?\.readObject\s*\(\s*\)/g,
    explanation:
      "Java deserialization on attacker-reachable bytes is one of the most reliable RCE primitives in the language. ObjectInputStream.readObject can instantiate any class on the classpath via gadget chains (commons-collections, springframework, etc.) — the attacker doesn't need write access to your code, just the right gadget library to be on the JVM. The 2015-2017 Spring + Apache Struts incidents that compromised Equifax used this exact shape.",
    verify_prompt:
      "Is the input stream attacker-reachable?\n" +
      "1. The stream comes from request.getInputStream() / a Kafka consumer / Redis / any network or storage that an attacker can write — CONFIRMED.\n" +
      "2. The stream is a fixed test resource bundled with the app — FALSE_POSITIVE.\n" +
      "3. The ObjectInputStream subclass overrides resolveClass and enforces a strict allowlist — FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template:
      "Replace Java serialization with JSON (Jackson) or Protocol Buffers. If you must keep Java serialization, subclass ObjectInputStream and override resolveClass to throw on any class outside an explicit allowlist of value-only DTOs.",
  },
  {
    id: "spring-002-spel-from-input",
    title: "Spring Expression Language (SpEL) evaluation of user input",
    severity: "critical",
    languages: ["java"],
    pack: "web",
    // SpelExpressionParser().parseExpression(<user input>).getValue()
    // OR @Value/@PreAuthorize SpEL injection (less common via static
    // grep but the .parseExpression form is the runtime hot one).
    regex:
      /\b(?:Spel|Standard)?ExpressionParser\s*\([^)]*\)[\s\S]{0,200}?\.parseExpression\s*\(\s*[^)"']*\b(?:request|input|params|payload|body)\b[^)]*\)/g,
    explanation:
      "Spring's Expression Language can call arbitrary methods (`T(java.lang.Runtime).getRuntime().exec(...)`) when evaluated. parseExpression with user-controlled input is a single-line RCE — well-known gadgets like `T(Runtime).getRuntime().exec(${cmd})` work out of the box on Spring Boot defaults. CVE-2022-22963 (Spring Cloud Function) was exactly this shape and was exploited at scale within a week of disclosure.",
    verify_prompt:
      "Is the parsed string actually user input?\n" +
      "1. parseExpression argument flows from request / input / params / payload / body — CONFIRMED.\n" +
      "2. The string is a hardcoded SpEL template with bound variables (variables, not the expression itself, are user-controlled) — borderline; FALSE_POSITIVE if the template is strict.\n" +
      "3. parseExpression is called with a constant — FALSE_POSITIVE.",
    cwe: "CWE-94",
    fix_template:
      "Don't pass user input to parseExpression. If you need user-controlled values inside a fixed SpEL expression, use the EvaluationContext to BIND user values as variables (`StandardEvaluationContext.setVariable`) and reference them in a HARDCODED expression as `#var`. Never let the user write the expression itself.",
  },
  {
    id: "spring-003-request-mapping-no-auth",
    title: "@PostMapping/@PutMapping/@DeleteMapping without @PreAuthorize / @Secured",
    severity: "high",
    languages: ["java", "kotlin"],
    pack: "web",
    // Match the mutation mapping annotation immediately followed by
    // the method definition, with no security annotation in between.
    // The lookahead avoids matching cases where @PreAuthorize sits
    // before @PostMapping on the same method.
    regex:
      /^\s*@(?:PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\([^)]*\)\s*\n(?!\s*@(?:PreAuthorize|Secured|RolesAllowed|Authenticated))\s*public\s+\S+\s+\w+\s*\(/gm,
    explanation:
      "Spring's mutation endpoints (@PostMapping etc.) are public unless an authorization annotation gates them or a SecurityFilterChain rule covers the path. Without either, ANY caller can POST. The framework provides @PreAuthorize / @Secured precisely so this gate is visible at the method declaration; missing it is the 2024-2025 most common controller bug.",
    verify_prompt:
      "Is the endpoint actually unauthenticated?\n" +
      "1. The method has no @PreAuthorize / @Secured / @RolesAllowed / @Authenticated annotation AND there's no visible SecurityFilterChain matching the path — CONFIRMED.\n" +
      "2. There IS a class-level @PreAuthorize that propagates — FALSE_POSITIVE.\n" +
      "3. Path is covered by SecurityFilterChain.requestMatchers().authenticated() in the security config — FALSE_POSITIVE.",
    cwe: "CWE-862",
    fix_template:
      'Add `@PreAuthorize("isAuthenticated()")` (or a more specific role check like `hasRole(\'ADMIN\')`) directly above the mapping. For class-wide enforcement, annotate the controller class once and use @PreAuthorize("permitAll()") on the few public methods that need it.',
  },
];
