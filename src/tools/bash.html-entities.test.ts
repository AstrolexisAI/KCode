import { describe, expect, test } from "bun:test";
import { decodeBashHtmlEntities } from "./bash";

describe("decodeBashHtmlEntities", () => {
  test("decodes the exact 2026-04-23 regression: mkdir ... &amp;&amp; cd", () => {
    const raw =
      "mkdir /home/curly/proyectos/bitcoin-tui-dashboard &amp;&amp; cd /home/curly/proyectos/bitcoin-tui-dashboard";
    const out = decodeBashHtmlEntities(raw);
    expect(out).toBe(
      "mkdir /home/curly/proyectos/bitcoin-tui-dashboard && cd /home/curly/proyectos/bitcoin-tui-dashboard",
    );
  });

  test("decodes &lt; and &gt; redirects", () => {
    expect(decodeBashHtmlEntities("cat file.txt &gt; out.txt")).toBe("cat file.txt > out.txt");
    expect(decodeBashHtmlEntities("sort &lt; input.txt")).toBe("sort < input.txt");
  });

  test("decodes &quot; in strings", () => {
    expect(decodeBashHtmlEntities("echo &quot;hello&quot;")).toBe('echo "hello"');
  });

  test("decodes &#39; and &apos;", () => {
    expect(decodeBashHtmlEntities("echo &#39;single&#39;")).toBe("echo 'single'");
    expect(decodeBashHtmlEntities("echo &apos;single&apos;")).toBe("echo 'single'");
  });

  test("leaves clean bash commands unchanged", () => {
    const clean = "cd ~/src && ls -la | grep foo";
    expect(decodeBashHtmlEntities(clean)).toBe(clean);
  });

  test("does NOT decode non-whitelisted entities", () => {
    // &nbsp; &copy; &trade; etc — not in the whitelist
    const raw = "echo &nbsp;&copy;";
    expect(decodeBashHtmlEntities(raw)).toBe(raw);
  });

  test("handles multiple entities in one command", () => {
    const raw = "grep &quot;&lt;.*&gt;&quot; &amp;&amp; echo done";
    expect(decodeBashHtmlEntities(raw)).toBe('grep "<.*>" && echo done');
  });

  test("handles empty string", () => {
    expect(decodeBashHtmlEntities("")).toBe("");
  });
});
