// KCode - taint flow tests (Fix #3 Phase 1)

import { describe, expect, it } from "bun:test";
import type { Candidate } from "../types";
import {
  classifyExpression,
  classifyJavaCandidate,
  extractTaintedVarName,
  findLastAssignment,
  shouldClassifyForTaint,
} from "./java";

const javaCandidate = (text: string, line = 50): Candidate => ({
  pattern_id: "java-023-sql-injection-var-flow",
  severity: "critical",
  file: "BenchmarkTest00001.java",
  line,
  matched_text: text,
  context: text,
});

describe("shouldClassifyForTaint", () => {
  it("matches the high-FP pattern set", () => {
    expect(shouldClassifyForTaint("java-023-sql-injection-var-flow")).toBe(true);
    expect(shouldClassifyForTaint("java-030-xss-writer-non-literal")).toBe(true);
    expect(shouldClassifyForTaint("java-005-nullable-method-call")).toBe(false);
    expect(shouldClassifyForTaint("python-001")).toBe(false);
  });
});

describe("extractTaintedVarName", () => {
  it("pulls var from String declaration", () => {
    const c = javaCandidate(
      'String sql = "SELECT * FROM x WHERE y = " + param; prepareStatement(sql);',
    );
    expect(extractTaintedVarName(c)).toBe("sql");
  });

  it("pulls var from sink call when no declaration in match", () => {
    const c = {
      ...javaCandidate("response.getWriter().println(out);"),
      pattern_id: "java-030-xss-writer-non-literal",
    };
    expect(extractTaintedVarName(c)).toBe("out");
  });

  it("returns null on unrecognizable shape", () => {
    expect(extractTaintedVarName(javaCandidate(""))).toBeNull();
  });
});

describe("classifyExpression — literals", () => {
  it("recognizes string literals", () => {
    expect(classifyExpression('"hello"').origin).toBe("constant");
  });
  it("recognizes numeric literals", () => {
    expect(classifyExpression("42").origin).toBe("constant");
    expect(classifyExpression("-3.14").origin).toBe("constant");
  });
  it("recognizes boolean / null", () => {
    expect(classifyExpression("true").origin).toBe("constant");
    expect(classifyExpression("null").origin).toBe("constant");
  });
});

describe("classifyExpression — taint sources", () => {
  it('flags request.getParameter("x")', () => {
    expect(classifyExpression('request.getParameter("x")').origin).toBe("tainted");
  });
  it("flags request.getHeader", () => {
    expect(classifyExpression('request.getHeader("X")').origin).toBe("tainted");
  });
  it("flags Cookie.getValue() in tail position", () => {
    expect(classifyExpression("theCookie.getValue()").origin).toBe("tainted");
  });
  it("flags System.getenv", () => {
    expect(classifyExpression('System.getenv("PATH")').origin).toBe("tainted");
  });
});

describe("classifyExpression — sanitizers", () => {
  it("Integer.parseInt over tainted value → sanitized", () => {
    const r = classifyExpression('Integer.parseInt(request.getParameter("x"))');
    expect(r.origin).toBe("sanitized");
  });
  it("ESAPI.encoder().encodeForHTML over tainted → sanitized", () => {
    const r = classifyExpression('ESAPI.encoder().encodeForHTML(request.getParameter("x"))');
    expect(r.origin).toBe("sanitized");
  });
  it("StringEscapeUtils.escapeHtml4 over tainted → sanitized", () => {
    const r = classifyExpression('StringEscapeUtils.escapeHtml4(request.getParameter("x"))');
    expect(r.origin).toBe("sanitized");
  });
});

describe("classifyExpression — concat", () => {
  it('"foo" + "bar" is constant', () => {
    expect(classifyExpression('"foo" + "bar"').origin).toBe("constant");
  });
  it('"foo" + request.getParameter("x") is tainted', () => {
    expect(classifyExpression('"foo" + request.getParameter("x")').origin).toBe("tainted");
  });
  it("constant + sanitized is sanitized", () => {
    expect(classifyExpression('"foo" + Integer.parseInt(request.getParameter("x"))').origin).toBe(
      "sanitized",
    );
  });
});

describe("findLastAssignment", () => {
  const file = `
public class T {
  void m() {
    String a = "constant";
    String b = request.getParameter("p");
    String sql = "SELECT * WHERE x = " + b;
    prepareStatement(sql);
  }
}
`.trim();

  it("finds single-line String declaration", () => {
    const r = findLastAssignment(file, "sql", 5);
    expect(r).not.toBeNull();
    expect(r?.rhs).toContain('"SELECT * WHERE x = " + b');
  });

  it("finds variable b's assignment", () => {
    const r = findLastAssignment(file, "b", 5);
    expect(r?.rhs).toBe('request.getParameter("p")');
  });
});

describe("classifyJavaCandidate — end-to-end", () => {
  it("constant chain → constant verdict", () => {
    const file = `
public class T {
  public void doPost() {
    String x = "fixed";
    String sql = "..." + x + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + x + "..."; prepareStatement(sql);', 4);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("constant");
  });

  it("taint chain → tainted verdict", () => {
    const file = `
public class T {
  public void doPost() {
    String p = request.getParameter("z");
    String sql = "..." + p + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + p + "..."; prepareStatement(sql);', 4);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("tainted");
  });

  it("sanitizer wrap → sanitized verdict", () => {
    const file = `
public class T {
  public void doPost() {
    String p = Integer.parseInt(request.getParameter("z"));
    String sql = "..." + p + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + p + "..."; prepareStatement(sql);', 4);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("sanitized");
  });

  it("declines to classify when last assignment is in a switch/case branch", () => {
    // OWASP BenchmarkTest00761/767/etc — switch over a char with one
    // case assigning the constant and another the tainted source.
    const file = `
public class T {
  public void doPost(char which, String param) {
    String bar;
    switch (which) {
      case 'A':
        bar = param;
        break;
      case 'B':
        bar = "bobs_your_uncle";
        break;
    }
    String sql = "..." + bar + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + bar + "...";', 13);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("unknown");
  });

  it("merges if/else branches: tainted branch + constant branch → tainted", () => {
    // Mirrors OWASP BenchmarkTest00762 / 00761 / 00673 shape: the if
    // branch assigns the tainted Servlet source, the else branch a
    // literal. The merge picks up the tainted path conservatively
    // so the candidate is preserved (no false suppression).
    const file = `
public class T {
  public void doPost() {
    String param = request.getParameter("p");
    String bar;
    int num = 196;
    if ((500 / 42) + num > 200) bar = param;
    else bar = "constant";
    String sql = "..." + bar + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + bar + "...";', 9);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("tainted");
  });

  it("Phase 2: same-file helper returning a constant → constant", () => {
    const file = `
public class T {
  String helper() {
    return "fixed";
  }
  public void doPost() {
    String x = helper();
    String sql = "..." + x + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + x + "...";', 8);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("constant");
  });

  it("Phase 3: cross-file helper class returning constant → constant", () => {
    // Mirrors OWASP SeparateClassRequest.getTheValue: a helper class
    // in another file whose method always returns a literal.
    const helperContent = `
public class Helper {
  public String getTheValue(String p) {
    return "bar";
  }
}
`.trim();
    const file = `
public class T {
  public void doPost() {
    Helper h = new Helper();
    String x = h.getTheValue("anything");
    String sql = "..." + x + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + x + "...";', 6);
    const r = classifyJavaCandidate(c, file, {
      filesInDir: new Map([["Helper", helperContent]]),
    });
    expect(r.origin).toBe("constant");
  });

  it("Phase 3: helper that propagates input → tainted (recall preserved)", () => {
    const helperContent = `
public class Helper {
  public String propagate(String p) {
    return p;
  }
}
`.trim();
    const file = `
public class T {
  public void doPost() {
    Helper h = new Helper();
    String x = h.propagate(request.getParameter("z"));
    String sql = "..." + x + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + x + "...";', 6);
    const r = classifyJavaCandidate(c, file, {
      filesInDir: new Map([["Helper", helperContent]]),
    });
    // Phase 3 sees `return p;` where p is the unresolved parameter →
    // unknown (no parameter modeling yet). Recall preserved.
    expect(["unknown", "tainted"]).toContain(r.origin);
  });

  it("Phase 4+5: doSomething wrapper with foldable cond + constant arg → constant", () => {
    // OWASP "safe" doSomething shape: the conditional always picks
    // the parameter branch, the call site passes a literal, so the
    // taint chain folds to a constant.
    const file = `
public class T {
  private static String doSomething(HttpServletRequest req, String param) {
    String bar;
    int num = 196;
    if ((500 / 42) + num > 200) bar = param;
    else bar = "unreachable";
    return bar;
  }
  public void doPost() {
    String param = "noCookieValueSupplied";
    String bar = doSomething(request, param);
    String sql = "..." + bar + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + bar + "...";', 13);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("constant");
  });

  it("Phase 4+5: doSomething with foldable cond + tainted arg → tainted", () => {
    // Same wrapper, but call site passes a Servlet API value; the
    // chain still folds, but to a tainted classification → preserved.
    const file = `
public class T {
  private static String doSomething(HttpServletRequest req, String param) {
    String bar;
    int num = 196;
    if ((500 / 42) + num > 200) bar = param;
    else bar = "unreachable";
    return bar;
  }
  public void doPost() {
    String param = request.getParameter("p");
    String bar = doSomething(request, param);
    String sql = "..." + bar + "...";
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate('String sql = "..." + bar + "...";', 13);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("tainted");
  });

  it("preserves recall on unknown shape", () => {
    const file = `
public class T {
  public void doPost() {
    String sql = mystery();
    prepareStatement(sql);
  }
}
`.trim();
    const c = javaCandidate("String sql = mystery(); prepareStatement(sql);", 3);
    const r = classifyJavaCandidate(c, file);
    expect(r.origin).toBe("unknown");
  });
});
