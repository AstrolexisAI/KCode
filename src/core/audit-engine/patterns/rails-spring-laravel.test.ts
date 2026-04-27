// P2.3 (v2.10.391) — Rails + Spring + Laravel framework pack tests.

import { describe, expect, test } from "bun:test";
import { LARAVEL_PATTERNS } from "./laravel";
import { RAILS_PATTERNS } from "./rails";
import { SPRING_PATTERNS } from "./spring";

function findIn<T extends { id: string; regex: RegExp }>(set: T[], id: string): T {
  const p = set.find((x) => x.id === id);
  if (!p) throw new Error(`Pattern not found: ${id}`);
  return p;
}

function matchAll(p: { regex: RegExp }, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  p.regex.lastIndex = 0;
  const re = new RegExp(p.regex.source, p.regex.flags);
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push(m);
    if (!re.global) break;
    m = re.exec(text);
  }
  return out;
}

// ─── Rails ───────────────────────────────────────────────────────

describe("rails-002-send-to-dynamic-method", () => {
  const p = findIn(RAILS_PATTERNS, "rails-002-send-to-dynamic-method");
  test("flags .send(params[:method])", () => {
    expect(matchAll(p, `user.send(params[:method])`).length).toBe(1);
  });
  test("flags .public_send(params[:cmd])", () => {
    expect(matchAll(p, `record.public_send(params[:cmd])`).length).toBe(1);
  });
  test("does NOT flag .send(:hardcoded_method)", () => {
    expect(matchAll(p, `user.send(:save)`).length).toBe(0);
  });
});

describe("rails-003-mass-assignment", () => {
  const p = findIn(RAILS_PATTERNS, "rails-003-mass-assignment");
  test("flags params.permit!", () => {
    expect(matchAll(p, `params.permit!`).length).toBe(1);
  });
  test("flags User.update(params[:user])", () => {
    expect(matchAll(p, `@user = User.update(params[:user])`).length).toBe(1);
  });
  test("does NOT flag params.require(:user).permit(:name, :email)", () => {
    expect(matchAll(p, `params.require(:user).permit(:name, :email)`).length).toBe(0);
  });
});

describe("rails-004-eval-instance-eval", () => {
  const p = findIn(RAILS_PATTERNS, "rails-004-eval-instance-eval");
  test("flags eval with params[:code]", () => {
    expect(matchAll(p, `eval(params[:code])`).length).toBe(1);
  });
  test("flags instance_eval with interpolated user data", () => {
    expect(matchAll(p, `instance_eval("foo \#{params[:x]}")`).length).toBe(1);
  });
  test("does NOT flag eval('1 + 1')", () => {
    expect(matchAll(p, `eval('1 + 1')`).length).toBe(0);
  });
});

describe("rails-005-render-inline", () => {
  const p = findIn(RAILS_PATTERNS, "rails-005-render-inline");
  test("flags render inline: with interpolation", () => {
    expect(matchAll(p, `render inline: "Hello \#{params[:name]}"`).length).toBe(1);
  });
  test("flags render inline: params[:tpl]", () => {
    expect(matchAll(p, `render inline: params[:tpl]`).length).toBe(1);
  });
  test("does NOT flag render :index", () => {
    expect(matchAll(p, `render :index`).length).toBe(0);
  });
});

// ─── Spring ──────────────────────────────────────────────────────

describe("spring-001-deserialization", () => {
  const p = findIn(SPRING_PATTERNS, "spring-001-deserialization");
  test("flags new ObjectInputStream(...).readObject()", () => {
    const code = `ObjectInputStream ois = new ObjectInputStream(request.getInputStream());
Object obj = ois.readObject();`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
});

describe("spring-002-spel-from-input", () => {
  const p = findIn(SPRING_PATTERNS, "spring-002-spel-from-input");
  test("flags SpelExpressionParser parsing input", () => {
    const code = `Expression e = new SpelExpressionParser().parseExpression(request.getParameter("q"));`;
    expect(matchAll(p, code).length).toBe(1);
  });
  test("does NOT flag a literal expression", () => {
    const code = `Expression e = new SpelExpressionParser().parseExpression("1 + 1");`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

describe("spring-003-request-mapping-no-auth", () => {
  const p = findIn(SPRING_PATTERNS, "spring-003-request-mapping-no-auth");
  test("flags @PostMapping without security annotation", () => {
    const code = `@PostMapping("/users")
public User create(@RequestBody User u) {
    return repo.save(u);
}`;
    expect(matchAll(p, code).length).toBeGreaterThanOrEqual(1);
  });
  test("does NOT flag @PostMapping with @PreAuthorize", () => {
    const code = `@PostMapping("/users")
@PreAuthorize("hasRole('ADMIN')")
public User create(@RequestBody User u) {
    return repo.save(u);
}`;
    expect(matchAll(p, code).length).toBe(0);
  });
});

// ─── Laravel ─────────────────────────────────────────────────────

describe("laravel-001-mass-assignment-fillable-empty", () => {
  const p = findIn(LARAVEL_PATTERNS, "laravel-001-mass-assignment-fillable-empty");
  test("flags Model::create($request->all())", () => {
    expect(matchAll(p, `User::create($request->all())`).length).toBe(1);
  });
  test("flags ->fill($request->all())", () => {
    expect(matchAll(p, `$user->fill($request->all())`).length).toBe(1);
  });
  test("does NOT flag Model::create($request->only([...]))", () => {
    expect(matchAll(p, `User::create($request->only(['name', 'email']))`).length).toBe(0);
  });
});

describe("laravel-002-eval-of-request", () => {
  const p = findIn(LARAVEL_PATTERNS, "laravel-002-eval-of-request");
  test("flags eval with $request", () => {
    expect(matchAll(p, `eval($request->input('code'))`).length).toBe(1);
  });
  test("flags eval with $_POST", () => {
    expect(matchAll(p, `eval($_POST['cmd'])`).length).toBe(1);
  });
  test("does NOT flag eval with hardcoded string", () => {
    expect(matchAll(p, `eval("return 42;")`).length).toBe(0);
  });
});

describe("laravel-003-raw-db-query-with-input", () => {
  const p = findIn(LARAVEL_PATTERNS, "laravel-003-raw-db-query-with-input");
  test("flags DB::raw with interpolated user data", () => {
    expect(matchAll(p, `DB::raw("select * from users where id = $request->id")`).length).toBe(1);
  });
  test("does NOT flag DB::select with placeholder", () => {
    expect(matchAll(p, `DB::select('select * from users where id = ?', [$id])`).length).toBe(0);
  });
});

// ─── Pack invariants ─────────────────────────────────────────────

describe("RAILS_PATTERNS invariants", () => {
  test("every pattern has pack='web', a CWE, ruby lang, rails- prefix", () => {
    for (const p of RAILS_PATTERNS) {
      expect(p.pack).toBe("web");
      expect(p.cwe).toBeTruthy();
      expect(p.languages).toContain("ruby");
      expect(p.id.startsWith("rails-")).toBe(true);
    }
  });
});

describe("SPRING_PATTERNS invariants", () => {
  test("every pattern has pack='web', a CWE, java lang, spring- prefix", () => {
    for (const p of SPRING_PATTERNS) {
      expect(p.pack).toBe("web");
      expect(p.cwe).toBeTruthy();
      expect(p.languages).toContain("java");
      expect(p.id.startsWith("spring-")).toBe(true);
    }
  });
});

describe("LARAVEL_PATTERNS invariants", () => {
  test("every pattern has pack='web', a CWE, php lang, laravel- prefix", () => {
    for (const p of LARAVEL_PATTERNS) {
      expect(p.pack).toBe("web");
      expect(p.cwe).toBeTruthy();
      expect(p.languages).toContain("php");
      expect(p.id.startsWith("laravel-")).toBe(true);
    }
  });
});
