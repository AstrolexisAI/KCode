// KCode - Code Chunker Tests

import { describe, expect, test } from "bun:test";
import { type CodeChunk, chunkFile } from "./code-chunker";

// ─── TypeScript / JavaScript ──────────────────────────────────

describe("code-chunker: TypeScript function extraction", () => {
  test("extracts named function declarations", () => {
    const content = `function hello() {
  return "world";
}

function goodbye() {
  return "bye";
}`;
    const chunks = chunkFile("test.ts", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(2);
    expect(funcs[0]!.name).toBe("hello");
    expect(funcs[1]!.name).toBe("goodbye");
  });

  test("extracts async function declarations", () => {
    const content = `export async function fetchData() {
  const res = await fetch("/api");
  return res.json();
}`;
    const chunks = chunkFile("test.ts", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(1);
    expect(funcs[0]!.name).toBe("fetchData");
  });

  test("extracts arrow function assignments", () => {
    const content = `export const handler = (req: Request) => {
  return new Response("ok");
}

const processItem = async (item: string) => {
  return item.toUpperCase();
}`;
    const chunks = chunkFile("test.ts", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(2);
    expect(funcs[0]!.name).toBe("handler");
    expect(funcs[1]!.name).toBe("processItem");
  });

  test("sets language to typescript for .ts files", () => {
    const chunks = chunkFile("src/core/app.ts", "const x = 1;");
    expect(chunks.every((c) => c.language === "typescript")).toBe(true);
  });

  test("sets language to javascript for .js files", () => {
    const chunks = chunkFile("app.js", "const x = 1;");
    expect(chunks.every((c) => c.language === "javascript")).toBe(true);
  });

  test("line numbers are 1-based", () => {
    const content = `function first() {
  return 1;
}

function second() {
  return 2;
}`;
    const chunks = chunkFile("test.ts", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs[0]!.lineStart).toBe(1);
    expect(funcs[1]!.lineStart).toBeGreaterThan(1);
  });
});

// ─── Class Extraction ─────────────────────────────────────────

describe("code-chunker: class extraction", () => {
  test("extracts class declarations", () => {
    const content = `export class MyService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  query(sql: string): any[] {
    return [];
  }
}`;
    const chunks = chunkFile("service.ts", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("MyService");
    expect(classes[0]!.content).toContain("constructor");
    expect(classes[0]!.content).toContain("query");
  });

  test("extracts abstract class declarations", () => {
    const content = `export abstract class BaseHandler {
  abstract handle(): void;
}`;
    const chunks = chunkFile("base.ts", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("BaseHandler");
  });

  test("class chunk includes full body up to closing brace", () => {
    const content = `class Config {
  field1: string;
  field2: number;
}`;
    const chunks = chunkFile("config.ts", content);
    const cls = chunks.find((c) => c.type === "class");
    expect(cls).toBeDefined();
    expect(cls!.content).toContain("field1");
    expect(cls!.content).toContain("field2");
  });
});

// ─── Import Block Extraction ──────────────────────────────────

describe("code-chunker: import block extraction", () => {
  test("extracts contiguous import blocks", () => {
    const content = `import { foo } from "./foo";
import { bar } from "./bar";
import { baz } from "./baz";

function doStuff() {
  return foo + bar + baz;
}`;
    const chunks = chunkFile("test.ts", content);
    const imports = chunks.filter((c) => c.type === "import");
    expect(imports.length).toBe(1);
    expect(imports[0]!.content).toContain("foo");
    expect(imports[0]!.content).toContain("bar");
    expect(imports[0]!.content).toContain("baz");
  });

  test("import chunk name includes filename", () => {
    const chunks = chunkFile("src/utils.ts", 'import { x } from "y";');
    const imp = chunks.find((c) => c.type === "import");
    expect(imp).toBeDefined();
    expect(imp!.name).toContain("utils.ts");
  });
});

// ─── Fallback Chunking ───────────────────────────────────────

describe("code-chunker: fallback chunking for unknown languages", () => {
  test("uses block chunks for unrecognized extensions", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    const chunks = chunkFile("data.txt", content);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.type).toBe("block");
    }
  });

  test("sets language to unknown for unrecognized extensions", () => {
    const chunks = chunkFile("data.xyz", "some content");
    expect(chunks[0]!.language).toBe("unknown");
  });

  test("handles empty content", () => {
    const chunks = chunkFile("empty.ts", "");
    // Single empty line produces no non-empty chunks
    expect(chunks.length).toBe(0);
  });
});

// ─── Max Chunk Size Enforcement ───────────────────────────────

describe("code-chunker: max chunk size enforcement", () => {
  test("large function bodies are truncated to ~2000 chars", () => {
    // Create a function with a very large body
    const bodyLines = Array.from(
      { length: 200 },
      (_, i) => `  const x${i} = "${i.toString().repeat(20)}";`,
    );
    const content = `function bigFunc() {\n${bodyLines.join("\n")}\n}`;
    const chunks = chunkFile("big.ts", content);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2100); // small tolerance
    }
  });

  test("fallback block chunks respect max size", () => {
    // 200 lines of long content in unknown language
    const lines = Array.from({ length: 200 }, (_, i) => `${"x".repeat(50)} line ${i}`);
    const content = lines.join("\n");
    const chunks = chunkFile("big.txt", content);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2100);
    }
  });
});

// ─── Python ───────────────────────────────────────────────────

describe("code-chunker: Python support", () => {
  test("extracts Python function definitions", () => {
    const content = `def hello():
    return "world"

def goodbye(name):
    print(f"bye {name}")
    return True`;
    const chunks = chunkFile("test.py", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(2);
    expect(funcs[0]!.name).toBe("hello");
    expect(funcs[1]!.name).toBe("goodbye");
  });

  test("extracts Python class definitions", () => {
    const content = `class MyClass:
    def __init__(self):
        self.value = 0

    def method(self):
        return self.value`;
    const chunks = chunkFile("test.py", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("MyClass");
  });

  test("extracts Python imports", () => {
    const content = `import os
from pathlib import Path
import sys

def main():
    pass`;
    const chunks = chunkFile("test.py", content);
    const imports = chunks.filter((c) => c.type === "import");
    expect(imports.length).toBe(1);
  });
});

// ─── Go ───────────────────────────────────────────────────────

describe("code-chunker: Go support", () => {
  test("extracts Go function declarations", () => {
    const content = `func main() {
	fmt.Println("hello")
}

func helper(x int) int {
	return x + 1
}`;
    const chunks = chunkFile("main.go", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(2);
    expect(funcs[0]!.name).toBe("main");
    expect(funcs[1]!.name).toBe("helper");
  });

  test("extracts Go struct types", () => {
    const content = `type Server struct {
	Host string
	Port int
}`;
    const chunks = chunkFile("server.go", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("Server");
  });
});

// ─── Rust ─────────────────────────────────────────────────────

describe("code-chunker: Rust support", () => {
  test("extracts Rust fn declarations", () => {
    const content = `pub fn process(data: &str) -> String {
    data.to_uppercase()
}

fn helper() {
    println!("help");
}`;
    const chunks = chunkFile("lib.rs", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(2);
    expect(funcs[0]!.name).toBe("process");
    expect(funcs[1]!.name).toBe("helper");
  });

  test("extracts Rust struct/enum/trait as class", () => {
    const content = `pub struct Config {
    field: String,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Handler {
    fn handle(&self);
}`;
    const chunks = chunkFile("types.rs", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(3);
  });
});

// ─── Java ─────────────────────────────────────────────────────

describe("code-chunker: Java support", () => {
  test("extracts Java class declarations", () => {
    const content = `public class App {
    public static void main(String[] args) {
        System.out.println("hello");
    }
}`;
    const chunks = chunkFile("App.java", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("App");
  });

  test("extracts Java imports", () => {
    const content = `import java.util.List;
import java.util.Map;

public class Test {
}`;
    const chunks = chunkFile("Test.java", content);
    const imports = chunks.filter((c) => c.type === "import");
    expect(imports.length).toBe(1);
  });
});

// ─── C/C++ ────────────────────────────────────────────────────

describe("code-chunker: C/C++ support", () => {
  test("extracts C function declarations", () => {
    const content = `int main(int argc, char **argv) {
    printf("hello\\n");
    return 0;
}`;
    const chunks = chunkFile("main.c", content);
    const funcs = chunks.filter((c) => c.type === "function");
    expect(funcs.length).toBe(1);
    expect(funcs[0]!.name).toBe("main");
  });

  test("extracts C++ class declarations", () => {
    const content = `class Widget {
    int x;
    int y;
};`;
    const chunks = chunkFile("widget.cpp", content);
    const classes = chunks.filter((c) => c.type === "class");
    expect(classes.length).toBe(1);
    expect(classes[0]!.name).toBe("Widget");
  });

  test("extracts #include blocks", () => {
    const content = `#include <stdio.h>
#include <stdlib.h>

int main() {
    return 0;
}`;
    const chunks = chunkFile("main.c", content);
    const imports = chunks.filter((c) => c.type === "import");
    expect(imports.length).toBe(1);
  });
});
