// KCode - Diff Viewer Component
// Line-by-line diff with LCS algorithm, collapsible unchanged regions

(function () {
  "use strict";

  // ─── LCS-based Diff Algorithm ─────────────────────────────────

  /**
   * Compute the longest common subsequence table
   * @param {string[]} a - Old lines
   * @param {string[]} b - New lines
   * @returns {number[][]} LCS length table
   */
  function lcsTable(a, b) {
    var m = a.length;
    var n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) {
          dp[i][j] = 0;
        } else if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    return dp;
  }

  /**
   * Backtrack through LCS table to produce diff operations
   * @param {number[][]} dp - LCS table
   * @param {string[]} a - Old lines
   * @param {string[]} b - New lines
   * @returns {Array<{type: string, oldLine?: number, newLine?: number, content: string}>}
   */
  function backtrack(dp, a, b) {
    var ops = [];
    var i = a.length;
    var j = b.length;

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.unshift({
          type: "context",
          oldLine: i,
          newLine: j,
          content: a[i - 1],
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.unshift({ type: "addition", newLine: j, content: b[j - 1] });
        j--;
      } else if (i > 0) {
        ops.unshift({ type: "deletion", oldLine: i, content: a[i - 1] });
        i--;
      }
    }

    return ops;
  }

  /**
   * Compute diff operations between two texts
   * @param {string} oldText
   * @param {string} newText
   * @returns {Array<{type: string, oldLine?: number, newLine?: number, content: string}>}
   */
  function computeDiff(oldText, newText) {
    var oldLines = oldText.split("\n");
    var newLines = newText.split("\n");

    // For very large files, fall back to a simpler approach
    if (oldLines.length > 5000 || newLines.length > 5000) {
      return simpleDiff(oldLines, newLines);
    }

    var dp = lcsTable(oldLines, newLines);
    return backtrack(dp, oldLines, newLines);
  }

  /**
   * Simple line-by-line diff for large files (no LCS)
   * @param {string[]} oldLines
   * @param {string[]} newLines
   * @returns {Array<{type: string, oldLine?: number, newLine?: number, content: string}>}
   */
  function simpleDiff(oldLines, newLines) {
    var ops = [];
    var maxLen = Math.max(oldLines.length, newLines.length);
    for (var i = 0; i < maxLen; i++) {
      var oldLine = i < oldLines.length ? oldLines[i] : null;
      var newLine = i < newLines.length ? newLines[i] : null;

      if (oldLine === newLine) {
        ops.push({
          type: "context",
          oldLine: i + 1,
          newLine: i + 1,
          content: oldLine,
        });
      } else {
        if (oldLine !== null) {
          ops.push({ type: "deletion", oldLine: i + 1, content: oldLine });
        }
        if (newLine !== null) {
          ops.push({ type: "addition", newLine: i + 1, content: newLine });
        }
      }
    }
    return ops;
  }

  /**
   * Escape HTML entities
   * @param {string} text
   * @returns {string}
   */
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ─── Rendering ────────────────────────────────────────────────

  /**
   * Group consecutive context lines for collapsing
   * @param {Array} ops - Diff operations
   * @param {number} contextSize - Lines of context to show around changes
   * @returns {Array} Grouped operations (with collapse markers)
   */
  function groupOps(ops, contextSize) {
    if (typeof contextSize === "undefined") contextSize = 3;
    var grouped = [];
    var contextRun = [];

    function flushContext() {
      if (contextRun.length <= contextSize * 2 + 1) {
        // Small enough to show fully
        for (var c = 0; c < contextRun.length; c++) {
          grouped.push(contextRun[c]);
        }
      } else {
        // Show first N, collapse middle, show last N
        for (var s = 0; s < contextSize; s++) {
          grouped.push(contextRun[s]);
        }
        grouped.push({
          type: "collapsed",
          count: contextRun.length - contextSize * 2,
          lines: contextRun.slice(contextSize, -contextSize),
        });
        for (var e = contextRun.length - contextSize; e < contextRun.length; e++) {
          grouped.push(contextRun[e]);
        }
      }
      contextRun = [];
    }

    for (var i = 0; i < ops.length; i++) {
      if (ops[i].type === "context") {
        contextRun.push(ops[i]);
      } else {
        flushContext();
        grouped.push(ops[i]);
      }
    }
    flushContext();

    return grouped;
  }

  /**
   * Render an inline diff view
   * @param {string} oldText - Original text
   * @param {string} newText - Modified text
   * @param {object} [options] - Options { contextSize: number }
   * @returns {string} HTML string
   */
  function renderDiff(oldText, newText, options) {
    var opts = options || {};
    var contextSize = typeof opts.contextSize === "number" ? opts.contextSize : 3;

    if (oldText === newText) {
      return '<div class="diff-view"><div class="diff-line context"><span class="diff-line-number"></span>No changes</div></div>';
    }

    var ops = computeDiff(oldText, newText);
    var grouped = groupOps(ops, contextSize);
    var html = ['<div class="diff-view">'];

    for (var i = 0; i < grouped.length; i++) {
      var op = grouped[i];

      if (op.type === "collapsed") {
        var collapseId = "diff-collapse-" + Math.random().toString(36).slice(2, 8);
        html.push(
          '<div class="diff-collapsed" data-collapse-id="' +
            collapseId +
            '" onclick="window.DiffViewer.expandCollapsed(this)">' +
            "... " +
            op.count +
            " unchanged lines ...</div>"
        );
        html.push(
          '<div class="diff-collapsed-content" id="' +
            collapseId +
            '" style="display:none">'
        );
        for (var c = 0; c < op.lines.length; c++) {
          var cl = op.lines[c];
          html.push(
            '<div class="diff-line context">' +
              '<span class="diff-line-number">' +
              (cl.oldLine || "") +
              "</span>" +
              '<span class="diff-line-number">' +
              (cl.newLine || "") +
              "</span>" +
              " " +
              escapeHtml(cl.content) +
              "</div>"
          );
        }
        html.push("</div>");
        continue;
      }

      var lineClass = op.type;
      var prefix = op.type === "addition" ? "+" : op.type === "deletion" ? "-" : " ";
      var oldNum = op.oldLine || "";
      var newNum = op.newLine || "";

      html.push(
        '<div class="diff-line ' +
          lineClass +
          '">' +
          '<span class="diff-line-number">' +
          oldNum +
          "</span>" +
          '<span class="diff-line-number">' +
          newNum +
          "</span>" +
          prefix +
          " " +
          escapeHtml(op.content) +
          "</div>"
      );
    }

    html.push("</div>");
    return html.join("\n");
  }

  /**
   * Render a side-by-side diff view
   * @param {string} oldText
   * @param {string} newText
   * @returns {string} HTML string
   */
  function renderSideBySide(oldText, newText) {
    var ops = computeDiff(oldText, newText);
    var html = [
      '<div class="diff-view diff-side-by-side"><div style="display:flex">',
      '<div style="flex:1;overflow-x:auto">',
    ];

    // Left side (old)
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === "context") {
        html.push(
          '<div class="diff-line context"><span class="diff-line-number">' +
            op.oldLine +
            "</span> " +
            escapeHtml(op.content) +
            "</div>"
        );
      } else if (op.type === "deletion") {
        html.push(
          '<div class="diff-line deletion"><span class="diff-line-number">' +
            op.oldLine +
            "</span>-" +
            escapeHtml(op.content) +
            "</div>"
        );
      } else {
        html.push('<div class="diff-line" style="visibility:hidden">&nbsp;</div>');
      }
    }

    html.push('</div><div style="flex:1;overflow-x:auto;border-left:1px solid var(--border-subtle)">');

    // Right side (new)
    for (var j = 0; j < ops.length; j++) {
      var op2 = ops[j];
      if (op2.type === "context") {
        html.push(
          '<div class="diff-line context"><span class="diff-line-number">' +
            op2.newLine +
            "</span> " +
            escapeHtml(op2.content) +
            "</div>"
        );
      } else if (op2.type === "addition") {
        html.push(
          '<div class="diff-line addition"><span class="diff-line-number">' +
            op2.newLine +
            "</span>+" +
            escapeHtml(op2.content) +
            "</div>"
        );
      } else {
        html.push('<div class="diff-line" style="visibility:hidden">&nbsp;</div>');
      }
    }

    html.push("</div></div></div>");
    return html.join("\n");
  }

  /**
   * Expand a collapsed diff region
   * @param {HTMLElement} el - The collapsed placeholder element
   */
  function expandCollapsed(el) {
    var id = el.getAttribute("data-collapse-id");
    var content = document.getElementById(id);
    if (content) {
      content.style.display = "block";
      el.style.display = "none";
    }
  }

  // Export
  window.DiffViewer = {
    renderDiff: renderDiff,
    renderSideBySide: renderSideBySide,
    computeDiff: computeDiff,
    expandCollapsed: expandCollapsed,
  };
})();
