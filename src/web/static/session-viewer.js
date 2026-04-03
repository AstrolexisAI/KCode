// KCode - Session Viewer Component
// Shows conversation messages with code highlighting and expandable tool calls.
// Fetches from /api/v1/messages endpoint.

(() => {
  function SessionViewer(containerEl, authToken) {
    this.container = containerEl;
    this.authToken = authToken;
    this.messages = [];
    this.total = 0;
    this.offset = 0;
    this.limit = 50;
    this.refreshInterval = null;
  }

  SessionViewer.prototype.init = function () {
    this.render();
    this.fetchData();
    this.refreshInterval = setInterval(() => this.fetchData(), 8000);
  };

  SessionViewer.prototype.destroy = function () {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  };

  SessionViewer.prototype.fetchData = function () {
    var headers = {};
    if (this.authToken) {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    fetch("/api/v1/messages?limit=" + this.limit + "&offset=" + this.offset, { headers: headers })
      .then((res) => res.json())
      .then((data) => {
        this.messages = data.messages || [];
        this.total = data.total || 0;
        this.renderContent();
      })
      .catch((err) => {
        this.renderError("Failed to load messages: " + err.message);
      });
  };

  SessionViewer.prototype.render = function () {
    this.container.innerHTML = "";

    var wrapper = document.createElement("div");
    wrapper.className = "dashboard-panel session-viewer";

    var titleRow = document.createElement("div");
    titleRow.className = "session-viewer-header";

    var title = document.createElement("h2");
    title.className = "dashboard-title";
    title.textContent = "Session Viewer";
    titleRow.appendChild(title);

    var refreshBtn = document.createElement("button");
    refreshBtn.className = "btn btn-secondary session-refresh-btn";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => this.fetchData());
    titleRow.appendChild(refreshBtn);

    wrapper.appendChild(titleRow);

    var content = document.createElement("div");
    content.className = "dashboard-content session-messages";
    content.id = "session-viewer-content";
    wrapper.appendChild(content);

    // Pagination
    var pagination = document.createElement("div");
    pagination.className = "session-pagination";
    pagination.id = "session-pagination";
    wrapper.appendChild(pagination);

    this.container.appendChild(wrapper);
    this.contentEl = content;
    this.paginationEl = pagination;
  };

  SessionViewer.prototype.renderContent = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";

    if (this.messages.length === 0) {
      var empty = document.createElement("div");
      empty.className = "dashboard-empty";
      empty.textContent = "No messages in this session yet.";
      this.contentEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < this.messages.length; i++) {
      var msg = this.messages[i];
      var msgEl = document.createElement("div");
      msgEl.className = "sv-message sv-" + msg.role;

      // Header
      var header = document.createElement("div");
      header.className = "sv-message-header";

      var roleSpan = document.createElement("span");
      roleSpan.className = "sv-role";
      roleSpan.textContent = msg.role === "user" ? "You" : "Assistant";
      header.appendChild(roleSpan);

      var indexSpan = document.createElement("span");
      indexSpan.className = "sv-index";
      indexSpan.textContent = "#" + msg.index;
      header.appendChild(indexSpan);

      msgEl.appendChild(header);

      // Body
      var body = document.createElement("div");
      body.className = "sv-message-body";

      var content = msg.content || "";
      body.innerHTML = renderMessageContent(content);
      msgEl.appendChild(body);

      this.contentEl.appendChild(msgEl);
    }

    this.renderPagination();
  };

  SessionViewer.prototype.renderPagination = function () {
    if (!this.paginationEl) return;
    this.paginationEl.innerHTML = "";

    var info = document.createElement("span");
    info.className = "sv-pagination-info";
    info.textContent =
      "Showing " +
      (this.offset + 1) +
      "-" +
      Math.min(this.offset + this.messages.length, this.total) +
      " of " +
      this.total;
    this.paginationEl.appendChild(info);

    var btnGroup = document.createElement("div");
    btnGroup.className = "sv-pagination-buttons";

    if (this.offset > 0) {
      var prevBtn = document.createElement("button");
      prevBtn.className = "btn btn-secondary";
      prevBtn.textContent = "Previous";
      prevBtn.addEventListener("click", () => {
        this.offset = Math.max(0, this.offset - this.limit);
        this.fetchData();
      });
      btnGroup.appendChild(prevBtn);
    }

    if (this.offset + this.limit < this.total) {
      var nextBtn = document.createElement("button");
      nextBtn.className = "btn btn-secondary";
      nextBtn.textContent = "Next";
      nextBtn.addEventListener("click", () => {
        this.offset += this.limit;
        this.fetchData();
      });
      btnGroup.appendChild(nextBtn);
    }

    this.paginationEl.appendChild(btnGroup);
  };

  SessionViewer.prototype.renderError = function (msg) {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";
    var errEl = document.createElement("div");
    errEl.className = "dashboard-error";
    errEl.textContent = msg;
    this.contentEl.appendChild(errEl);
  };

  // ─── Content Rendering ─────────────────────────────────────────

  function renderMessageContent(content) {
    // Parse tool calls: [tool: Name] ... [result] or [result (error)]
    var parts = [];
    var remaining = content;

    // Split on tool patterns
    var toolStartRe = /\[tool:\s*(\w+)\]/g;
    var lastIdx = 0;
    var match;

    while ((match = toolStartRe.exec(remaining)) !== null) {
      // Text before tool
      if (match.index > lastIdx) {
        parts.push({ type: "text", value: remaining.slice(lastIdx, match.index) });
      }

      var toolName = match[1];

      // Find the result for this tool
      var afterTool = remaining.slice(match.index + match[0].length);
      var resultMatch = afterTool.match(
        /^\s*\[result(\s*\(error\))?\]\s*([\s\S]*?)(?=\[tool:|\[result|$)/,
      );

      if (resultMatch) {
        var isError = !!resultMatch[1];
        var resultText = (resultMatch[2] || "").trim();
        parts.push({
          type: "tool",
          name: toolName,
          result: resultText,
          isError: isError,
        });
        lastIdx = match.index + match[0].length + resultMatch[0].length;
        toolStartRe.lastIndex = lastIdx;
      } else {
        parts.push({ type: "tool", name: toolName, result: "", isError: false });
        lastIdx = match.index + match[0].length;
      }
    }

    if (lastIdx < remaining.length) {
      parts.push({ type: "text", value: remaining.slice(lastIdx) });
    }

    // Render parts to HTML
    var html = "";
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.type === "text") {
        html += renderTextContent(part.value);
      } else if (part.type === "tool") {
        html += renderToolCall(part.name, part.result, part.isError);
      }
    }

    return html || '<span class="sv-empty">Empty message</span>';
  }

  function renderTextContent(text) {
    // Handle code blocks
    var codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    var result = "";
    var lastIdx = 0;
    var match;

    while ((match = codeBlockRe.exec(text)) !== null) {
      // Text before code block
      if (match.index > lastIdx) {
        result += escapeHtml(text.slice(lastIdx, match.index));
      }

      var lang = match[1] || "";
      var code = match[2] || "";
      result +=
        '<div class="sv-code-block">' +
        (lang ? '<div class="sv-code-lang">' + escapeHtml(lang) + "</div>" : "") +
        "<pre><code>" +
        escapeHtml(code) +
        "</code></pre></div>";

      lastIdx = match.index + match[0].length;
    }

    if (lastIdx < text.length) {
      result += escapeHtml(text.slice(lastIdx));
    }

    return '<div class="sv-text">' + result + "</div>";
  }

  function renderToolCall(name, resultText, isError) {
    var id = "sv-tool-" + Math.random().toString(36).slice(2, 8);
    var statusClass = isError ? "sv-tool-error" : "sv-tool-success";
    var statusLabel = isError ? "Error" : "Done";

    var html =
      '<div class="sv-tool-call">' +
      '<div class="sv-tool-header" onclick="document.getElementById(\'' +
      id +
      "').classList.toggle('expanded')\">" +
      '<span class="sv-tool-name">' +
      escapeHtml(name) +
      "</span>" +
      '<span class="sv-tool-status ' +
      statusClass +
      '">' +
      statusLabel +
      "</span>" +
      '<span class="sv-tool-toggle">&#9654;</span>' +
      "</div>";

    if (resultText) {
      html +=
        '<div class="sv-tool-body" id="' +
        id +
        '">' +
        "<pre>" +
        escapeHtml(truncate(resultText, 3000)) +
        "</pre></div>";
    }

    html += "</div>";
    return html;
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + "\n... (" + (str.length - maxLen) + " chars truncated)";
  }

  window.SessionViewer = SessionViewer;
})();
