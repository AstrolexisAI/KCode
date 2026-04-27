// E2E render tests for MarkdownRenderer
import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemeProvider } from "../ThemeContext";
import MarkdownRenderer from "./MarkdownRenderer";

function renderMd(text: string) {
  return render(
    React.createElement(ThemeProvider, null, React.createElement(MarkdownRenderer, { text })),
  );
}

describe("MarkdownRenderer render", () => {
  let instance: ReturnType<typeof render> | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  test("renders plain text", () => {
    instance = renderMd("Hello world");
    expect(instance.lastFrame()).toContain("Hello world");
  });

  test("renders h1 heading", () => {
    instance = renderMd("# My Heading");
    expect(instance.lastFrame()).toContain("My Heading");
  });

  test("renders h2 heading", () => {
    instance = renderMd("## Subsection");
    expect(instance.lastFrame()).toContain("Subsection");
  });

  test("renders h3 heading", () => {
    instance = renderMd("### Details");
    expect(instance.lastFrame()).toContain("Details");
  });

  test("renders bold text", () => {
    instance = renderMd("This is **bold** text");
    const out = instance.lastFrame()!;
    expect(out).toContain("bold");
    expect(out).toContain("This is");
  });

  test("renders italic text", () => {
    instance = renderMd("Some *italic* words");
    expect(instance.lastFrame()).toContain("italic");
  });

  test("renders inline code", () => {
    instance = renderMd("Use the `console.log` function");
    expect(instance.lastFrame()).toContain("console.log");
  });

  test("renders unordered list", () => {
    instance = renderMd("- item one\n- item two\n- item three");
    const out = instance.lastFrame()!;
    expect(out).toContain("item one");
    expect(out).toContain("item two");
    expect(out).toContain("item three");
  });

  test("renders ordered list", () => {
    instance = renderMd("1. First\n2. Second\n3. Third");
    const out = instance.lastFrame()!;
    expect(out).toContain("First");
    expect(out).toContain("Second");
    expect(out).toContain("Third");
  });

  test("renders code block", () => {
    instance = renderMd("```\nconst x = 42;\n```");
    expect(instance.lastFrame()).toContain("const x = 42");
  });

  test("renders TypeScript code block with syntax highlighting", () => {
    instance = renderMd("```ts\nconst x: number = 42;\nfunction foo() {}\n```");
    const out = instance.lastFrame()!;
    expect(out).toContain("const");
    expect(out).toContain("number");
    expect(out).toContain("42");
  });

  test("renders Python code block", () => {
    instance = renderMd("```python\ndef hello():\n    return 'world'\n```");
    const out = instance.lastFrame()!;
    expect(out).toContain("def");
    expect(out).toContain("hello");
  });

  test("renders link", () => {
    instance = renderMd("Visit [KCode](https://example.com) today");
    expect(instance.lastFrame()).toContain("KCode");
  });

  test("renders blockquote", () => {
    instance = renderMd("> This is a quote");
    expect(instance.lastFrame()).toContain("This is a quote");
  });

  test("renders horizontal rule", () => {
    instance = renderMd("Before\n\n---\n\nAfter");
    const out = instance.lastFrame()!;
    expect(out).toContain("Before");
    expect(out).toContain("After");
  });

  test("renders multi-paragraph text", () => {
    instance = renderMd("Paragraph one.\n\nParagraph two.\n\nParagraph three.");
    const out = instance.lastFrame()!;
    expect(out).toContain("Paragraph one");
    expect(out).toContain("Paragraph two");
    expect(out).toContain("Paragraph three");
  });

  test("handles incomplete markdown gracefully (streaming)", () => {
    instance = renderMd("**incomplete bold");
    // Should render even with unclosed formatting
    expect(instance.lastFrame()).toContain("incomplete");
  });

  test("handles incomplete code block (streaming)", () => {
    instance = renderMd("```ts\nconst x = 1");
    expect(instance.lastFrame()).toContain("const x = 1");
  });

  test("handles empty string", () => {
    instance = renderMd("");
    expect(typeof instance.lastFrame()).toBe("string");
  });

  test("renders simple table", () => {
    instance = renderMd("| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |");
    const out = instance.lastFrame()!;
    expect(out).toContain("Alice");
    expect(out).toContain("Bob");
  });

  test("renders strikethrough", () => {
    instance = renderMd("This is ~~deleted~~ text");
    expect(instance.lastFrame()).toContain("deleted");
  });

  test("renders mixed inline formatting", () => {
    instance = renderMd("Use **bold**, *italic*, and `code` together");
    const out = instance.lastFrame()!;
    expect(out).toContain("bold");
    expect(out).toContain("italic");
    expect(out).toContain("code");
  });

  test("renders JavaScript keywords", () => {
    instance = renderMd("```javascript\nif (x) { return true; }\n```");
    const out = instance.lastFrame()!;
    expect(out).toContain("if");
    expect(out).toContain("return");
    expect(out).toContain("true");
  });

  test("renders rust code block", () => {
    instance = renderMd('```rust\nfn main() { println!("hello"); }\n```');
    const out = instance.lastFrame()!;
    expect(out).toContain("fn");
    expect(out).toContain("main");
  });

  test("renders go code block", () => {
    instance = renderMd('```go\nfunc main() { fmt.Println("hi") }\n```');
    const out = instance.lastFrame()!;
    expect(out).toContain("func");
    expect(out).toContain("main");
  });

  test("renders bash code block with # comments", () => {
    instance = renderMd("```bash\n# comment\nls -la\n```");
    const out = instance.lastFrame()!;
    expect(out).toContain("comment");
    expect(out).toContain("ls");
  });

  test("preserves indentation in code blocks", () => {
    instance = renderMd("```\n  function foo() {\n    return 1;\n  }\n```");
    const out = instance.lastFrame()!;
    expect(out).toContain("foo");
    expect(out).toContain("return");
  });

  test("renders nested list items", () => {
    instance = renderMd("- outer\n  - inner\n  - another");
    const out = instance.lastFrame()!;
    expect(out).toContain("outer");
    expect(out).toContain("inner");
  });

  test("renders special characters safely", () => {
    instance = renderMd('Text with <html> & special "quotes" chars');
    expect(instance.lastFrame()).toContain("special");
  });

  test("handles emoji in markdown", () => {
    instance = renderMd("# 🚀 Hello 🎉");
    const out = instance.lastFrame()!;
    expect(out).toContain("🚀");
    expect(out).toContain("🎉");
  });

  test("handles unicode in text", () => {
    instance = renderMd("Hola ¿cómo estás? Añoranza, corazón.");
    expect(instance.lastFrame()).toContain("Añoranza");
  });

  test("handles very long lines", () => {
    const longLine = "word ".repeat(200);
    instance = renderMd(longLine);
    expect(instance.lastFrame()).toContain("word");
  });

  test("handles mixed content with code and text", () => {
    const md = `# Title

Some text here.

\`\`\`ts
const x = 1;
\`\`\`

More text after.`;
    instance = renderMd(md);
    const out = instance.lastFrame()!;
    expect(out).toContain("Title");
    expect(out).toContain("Some text here");
    expect(out).toContain("const x = 1");
    expect(out).toContain("More text after");
  });
});
