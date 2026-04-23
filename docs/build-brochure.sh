#!/usr/bin/env bash
# Build brochure.pdf from brochure.md using wkhtmltopdf (no pandoc required)
#
# Usage: ./build-brochure.sh
# Output: brochure.pdf in this directory

set -e
cd "$(dirname "$0")"

# 1. Convert markdown to HTML via Bun's markdown renderer (or fallback)
cat > /tmp/brochure.html <<'HTML_HEAD'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>KCode — Kulvex</title>
<style>
  @page { size: A4; margin: 18mm 20mm; }
  body {
    font-family: -apple-system, "Segoe UI", "Inter", sans-serif;
    color: #1a1a1a;
    font-size: 10.5pt;
    line-height: 1.5;
    max-width: 170mm;
    margin: 0 auto;
  }
  h1 { font-size: 28pt; color: #0a0e1a; margin: 0.2em 0 0.1em; letter-spacing: -0.02em; }
  h2 { font-size: 16pt; color: #0a0e1a; margin-top: 1.4em; border-bottom: 2px solid #e0e6ed; padding-bottom: 4px; }
  h3 { font-size: 12pt; color: #333; margin-top: 1em; }
  p { margin: 0.5em 0; }
  strong { color: #0a0e1a; }
  code {
    font-family: "SF Mono", "Fira Code", Consolas, monospace;
    background: #f4f4f8;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9.5pt;
  }
  pre {
    background: #0a0e1a;
    color: #e0e6ed;
    padding: 12px 14px;
    border-radius: 6px;
    font-size: 8.5pt;
    line-height: 1.4;
    overflow-x: auto;
    page-break-inside: avoid;
  }
  pre code { background: transparent; color: inherit; padding: 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 9.5pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  th { background: #f4f4f8; font-weight: 600; color: #0a0e1a; }
  tr:nth-child(even) td { background: #fafbfc; }
  blockquote {
    border-left: 3px solid #00ff88;
    margin: 0.8em 0;
    padding: 4px 14px;
    color: #555;
    background: #f8faf9;
  }
  hr { border: none; border-top: 1px solid #e0e6ed; margin: 2em 0; }
  ul, ol { margin: 0.3em 0 0.8em 1.5em; padding: 0; }
  li { margin: 0.15em 0; }
  a { color: #0066cc; text-decoration: none; }
  img { max-width: 120px; display: block; margin: 0 auto; }
  .header-center { text-align: center; }
  em { color: #555; font-style: italic; font-size: 9.5pt; }
</style>
</head>
<body>
HTML_HEAD

# 2. Use Bun to convert markdown to HTML
bun -e '
import { readFileSync, appendFileSync } from "node:fs";
const md = readFileSync("brochure.md", "utf-8");

// Minimal markdown → HTML (handles what brochure.md uses)
function mdToHtml(s) {
  // Protect fenced code
  const blocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</code></pre>`);
    return `\x00${blocks.length-1}\x00`;
  });
  // Tables
  s = s.replace(/((?:^\|.+\|\n)+)/gm, (block) => {
    const lines = block.trim().split(/\n/);
    if (lines.length < 2) return block;
    const cells = (l) => l.split("|").slice(1, -1).map(c => c.trim());
    const header = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    let h = "<table><thead><tr>" + header.map(c=>`<th>${c}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of rows) h += "<tr>" + r.map(c=>`<td>${c}</td>`).join("") + "</tr>";
    return h + "</tbody></table>";
  });
  // Images (before links)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<img src=\"$2\" alt=\"$1\">");
  // div align center (keep as-is)
  // Headers
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
  // Bold / italic / code
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<![`\w])`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  // HR
  s = s.replace(/^---+$/gm, "<hr>");
  // Lists
  s = s.replace(/(^- .+(?:\n- .+)*)/gm, (m) => {
    const items = m.split(/\n/).map(l => l.replace(/^- /, "")).map(l => `<li>${l}</li>`).join("");
    return `<ul>${items}</ul>`;
  });
  // Paragraphs (simple)
  s = s.split(/\n\n+/).map(p => {
    if (/^<(h\d|ul|ol|pre|blockquote|table|hr|div|img)/.test(p.trim())) return p;
    if (!p.trim()) return "";
    return `<p>${p.replace(/\n/g, " ")}</p>`;
  }).join("\n\n");
  // Restore fenced code
  s = s.replace(/\x00(\d+)\x00/g, (_,i) => blocks[+i]);
  // Italic (after everything, to avoid eating inside code)
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*/g, "<em>$1</em>");
  return s;
}
appendFileSync("/tmp/brochure.html", mdToHtml(md));
' 2>&1

# 3. Close HTML
echo "</body></html>" >> /tmp/brochure.html

# 3b. Resolve relative image paths to absolute file:// URLs for wkhtmltopdf
DOCS_DIR="$(pwd)"
sed -i "s|src=\"\\./assets/|src=\"file://${DOCS_DIR}/assets/|g" /tmp/brochure.html

# 4. Render to PDF
wkhtmltopdf \
  --enable-local-file-access \
  --page-size A4 \
  --margin-top 18mm --margin-bottom 18mm \
  --margin-left 20mm --margin-right 20mm \
  --encoding UTF-8 \
  --quiet \
  /tmp/brochure.html brochure.pdf

echo "✓ brochure.pdf generated ($(du -h brochure.pdf | cut -f1))"
