// KCode - Lightweight Markdown Renderer
// No external dependencies. XSS-safe.

(function () {
  "use strict";

  /**
   * Escape HTML entities to prevent XSS
   * @param {string} text
   * @returns {string}
   */
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Process inline markdown: bold, italic, code, links, strikethrough
   * @param {string} text - Already HTML-escaped text
   * @returns {string}
   */
  function processInline(text) {
    // Inline code (must be first to prevent inner processing)
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold + Italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");

    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");

    // Italic
    text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
    text = text.replace(/_(.+?)_/g, "<em>$1</em>");

    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Links [text](url)
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Auto-link bare URLs
    text = text.replace(
      /(?<!")(?<!=)(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    return text;
  }

  /**
   * Render markdown text to HTML
   * @param {string} text - Raw markdown text
   * @returns {string} HTML string
   */
  function renderMarkdown(text) {
    if (!text) return "";

    var lines = text.split("\n");
    var html = [];
    var inCodeBlock = false;
    var codeBlockLang = "";
    var codeLines = [];
    var inList = false;
    var listType = "";
    var inBlockquote = false;
    var blockquoteLines = [];
    var inTable = false;
    var tableRows = [];
    var inParagraph = false;
    var paragraphLines = [];

    function flushParagraph() {
      if (inParagraph && paragraphLines.length > 0) {
        html.push("<p>" + processInline(paragraphLines.join(" ")) + "</p>");
        paragraphLines = [];
        inParagraph = false;
      }
    }

    function flushBlockquote() {
      if (inBlockquote && blockquoteLines.length > 0) {
        html.push(
          "<blockquote>" +
            renderMarkdown(blockquoteLines.join("\n")) +
            "</blockquote>"
        );
        blockquoteLines = [];
        inBlockquote = false;
      }
    }

    function flushList() {
      if (inList) {
        html.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
        listType = "";
      }
    }

    function flushTable() {
      if (inTable && tableRows.length > 0) {
        var tableHtml = "<table>";
        for (var r = 0; r < tableRows.length; r++) {
          if (r === 1 && /^[\s|:-]+$/.test(tableRows[r])) continue; // skip separator
          var tag = r === 0 ? "th" : "td";
          var cells = tableRows[r]
            .replace(/^\||\|$/g, "")
            .split("|")
            .map(function (c) {
              return c.trim();
            });
          tableHtml += "<tr>";
          for (var c = 0; c < cells.length; c++) {
            tableHtml +=
              "<" +
              tag +
              ">" +
              processInline(escapeHtml(cells[c])) +
              "</" +
              tag +
              ">";
          }
          tableHtml += "</tr>";
        }
        tableHtml += "</table>";
        html.push(tableHtml);
        tableRows = [];
        inTable = false;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Code blocks (fenced)
      if (line.match(/^```/)) {
        if (inCodeBlock) {
          // End code block
          var escapedCode = escapeHtml(codeLines.join("\n"));
          var langClass = codeBlockLang
            ? ' class="language-' + escapeHtml(codeBlockLang) + '"'
            : "";
          var langLabel = codeBlockLang
            ? '<span class="code-lang-label">' +
              escapeHtml(codeBlockLang) +
              "</span>"
            : "";
          html.push(
            '<div class="code-block-wrapper">' +
              langLabel +
              '<button class="copy-btn" onclick="window.MarkdownRenderer.copyCode(this)">Copy</button>' +
              "<pre><code" +
              langClass +
              ">" +
              escapedCode +
              "</code></pre></div>"
          );
          codeLines = [];
          codeBlockLang = "";
          inCodeBlock = false;
        } else {
          // Start code block
          flushParagraph();
          flushBlockquote();
          flushList();
          flushTable();
          codeBlockLang = line.slice(3).trim();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        flushParagraph();
        flushBlockquote();
        flushList();
        flushTable();
        html.push("<hr>");
        continue;
      }

      // Headers
      var headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        flushParagraph();
        flushBlockquote();
        flushList();
        flushTable();
        var level = headerMatch[1].length;
        html.push(
          "<h" +
            level +
            ">" +
            processInline(escapeHtml(headerMatch[2])) +
            "</h" +
            level +
            ">"
        );
        continue;
      }

      // Blockquote
      var bqMatch = line.match(/^>\s?(.*)$/);
      if (bqMatch) {
        flushParagraph();
        flushList();
        flushTable();
        inBlockquote = true;
        blockquoteLines.push(bqMatch[1]);
        continue;
      } else if (inBlockquote) {
        flushBlockquote();
      }

      // Table detection
      if (line.includes("|") && line.trim().startsWith("|")) {
        flushParagraph();
        flushBlockquote();
        flushList();
        inTable = true;
        tableRows.push(line);
        continue;
      } else if (inTable) {
        flushTable();
      }

      // Unordered list
      var ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)$/);
      if (ulMatch) {
        flushParagraph();
        flushBlockquote();
        flushTable();
        if (!inList || listType !== "ul") {
          flushList();
          html.push("<ul>");
          inList = true;
          listType = "ul";
        }
        html.push("<li>" + processInline(escapeHtml(ulMatch[2])) + "</li>");
        continue;
      }

      // Ordered list
      var olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (olMatch) {
        flushParagraph();
        flushBlockquote();
        flushTable();
        if (!inList || listType !== "ol") {
          flushList();
          html.push("<ol>");
          inList = true;
          listType = "ol";
        }
        html.push("<li>" + processInline(escapeHtml(olMatch[2])) + "</li>");
        continue;
      }

      // End list if we reach a non-list line
      if (inList && line.trim() === "") {
        flushList();
        continue;
      } else if (inList && !ulMatch && !olMatch) {
        flushList();
      }

      // Empty line
      if (line.trim() === "") {
        flushParagraph();
        continue;
      }

      // Regular text — accumulate into paragraph
      inParagraph = true;
      paragraphLines.push(escapeHtml(line));
    }

    // Flush remaining state
    if (inCodeBlock && codeLines.length > 0) {
      var escapedRemaining = escapeHtml(codeLines.join("\n"));
      html.push("<pre><code>" + escapedRemaining + "</code></pre>");
    }
    flushParagraph();
    flushBlockquote();
    flushList();
    flushTable();

    return html.join("\n");
  }

  /**
   * Copy code block content to clipboard
   * @param {HTMLElement} btn - The copy button element
   */
  function copyCode(btn) {
    var pre = btn.parentElement.querySelector("pre");
    if (!pre) return;

    var code = pre.querySelector("code");
    var text = code ? code.textContent : pre.textContent;

    navigator.clipboard
      .writeText(text)
      .then(function () {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 2000);
      })
      .catch(function () {
        // Fallback for older browsers
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 2000);
      });
  }

  // Export
  window.MarkdownRenderer = {
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
    copyCode: copyCode,
  };
})();
