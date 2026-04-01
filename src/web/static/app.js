// KCode - Web UI Application
// Vanilla JS, no frameworks. Manages WebSocket connection, message rendering,
// input handling, and all UI interactions.

(() => {
  // ─── Constants ────────────────────────────────────────────────

  var RECONNECT_BASE_MS = 1000;
  var RECONNECT_MAX_MS = 30000;
  var INPUT_HISTORY_MAX = 100;
  var SCROLL_THRESHOLD = 80; // pixels from bottom to auto-scroll

  // ─── KCode Web UI Class ───────────────────────────────────────

  function KCodeWebUI() {
    // Connection
    this.ws = null;
    this.wsUrl = "";
    this.authToken = "";
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connected = false;

    // State
    this.messages = [];
    this.currentStreamId = null;
    this.currentStreamEl = null;
    this.currentStreamText = "";
    this.permissionRequests = new Map();
    this.inputHistory = [];
    this.inputHistoryIndex = -1;
    this.inputDraft = "";
    this.isStreaming = false;
    this.autoScroll = true;
    this.isDarkTheme = true;
    this.searchActive = false;
    this.sessionModel = "--";
    this.activeTab = "chat";

    // Dashboard components
    this.modelDashboard = null;
    this.analyticsDashboard = null;
    this.sessionViewer = null;
    this.configPanel = null;

    // DOM elements (populated in init)
    this.els = {};
  }

  // ─── Initialization ───────────────────────────────────────────

  KCodeWebUI.prototype.init = function () {
    this.cacheElements();
    this.bindEvents();
    this.extractToken();
    this.connect();
    this.loadTheme();
    this.autoResizeInput();
    this.initTabs();
  };

  KCodeWebUI.prototype.cacheElements = function () {
    this.els = {
      messages: document.getElementById("messages"),
      messageInput: document.getElementById("message-input"),
      sendBtn: document.getElementById("send-btn"),
      cancelBtn: document.getElementById("cancel-btn"),
      connectionStatus: document.getElementById("connection-status"),
      modelName: document.getElementById("model-name"),
      tokenCount: document.getElementById("token-count"),
      costDisplay: document.getElementById("cost-display"),
      charCount: document.getElementById("char-count"),
      streamingIndicator: document.getElementById("streaming-indicator"),
      themeToggle: document.getElementById("theme-toggle"),
      searchBar: document.getElementById("search-bar"),
      searchInput: document.getElementById("search-input"),
      searchClose: document.getElementById("search-close"),
      permissionOverlay: document.getElementById("permission-overlay"),
      permissionDescription: document.getElementById("permission-description"),
      permissionDetails: document.getElementById("permission-details"),
      permAllow: document.getElementById("perm-allow"),
      permAlways: document.getElementById("perm-always"),
      permDeny: document.getElementById("perm-deny"),
      toolPanel: document.getElementById("tool-panel"),
      toolPanelContent: document.getElementById("tool-panel-content"),
      toolPanelClose: document.getElementById("tool-panel-close"),
      welcomeMessage: document.getElementById("welcome-message"),
    };
  };

  KCodeWebUI.prototype.bindEvents = function () {
    // Send message
    this.els.sendBtn.addEventListener("click", () => {
      this.sendMessage();
    });

    // Cancel
    this.els.cancelBtn.addEventListener("click", () => {
      this.cancelMessage();
    });

    // Input handling
    this.els.messageInput.addEventListener("keydown", (e) => {
      this.handleInputKeydown(e);
    });

    this.els.messageInput.addEventListener("input", () => {
      this.autoResizeInput();
      this.updateCharCount();
    });

    // Scroll detection for auto-scroll
    this.els.messages.addEventListener("scroll", () => {
      var el = this.els.messages;
      var distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.autoScroll = distanceFromBottom < SCROLL_THRESHOLD;
    });

    // Theme toggle
    this.els.themeToggle.addEventListener("click", () => {
      this.toggleTheme();
    });

    // Search
    this.els.searchClose.addEventListener("click", () => {
      this.closeSearch();
    });

    this.els.searchInput.addEventListener("input", () => {
      this.performSearch(this.els.searchInput.value);
    });

    // Tool panel close
    this.els.toolPanelClose.addEventListener("click", () => {
      this.els.toolPanel.classList.add("hidden");
    });

    // Permission buttons
    this.els.permAllow.addEventListener("click", () => {
      this.respondPermission("allow");
    });
    this.els.permAlways.addEventListener("click", () => {
      this.respondPermission("always_allow");
    });
    this.els.permDeny.addEventListener("click", () => {
      this.respondPermission("deny");
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Ctrl+F for search
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        this.openSearch();
      }
      // Escape to close overlays
      if (e.key === "Escape") {
        if (this.searchActive) this.closeSearch();
        if (!this.els.permissionOverlay.classList.contains("hidden")) {
          // Don't auto-close permission — user must explicitly respond
        }
      }
    });
  };

  // ─── Token & Connection ───────────────────────────────────────

  KCodeWebUI.prototype.extractToken = function () {
    var params = new URLSearchParams(window.location.search);
    this.authToken = params.get("token") || "";

    // Build WebSocket URL
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl =
      proto + "//" + window.location.host + "/ws?token=" + encodeURIComponent(this.authToken);
  };

  KCodeWebUI.prototype.connect = function () {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
    }

    this.setConnectionStatus("connecting");

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this.setConnectionStatus("disconnected");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.setConnectionStatus("connected");
    };

    this.ws.onmessage = (evt) => {
      try {
        var data = JSON.parse(evt.data);
        this.handleServerEvent(data);
      } catch (e) {
        console.warn("Failed to parse WebSocket message:", e);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.setConnectionStatus("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.connected = false;
      this.setConnectionStatus("disconnected");
    };
  };

  KCodeWebUI.prototype.scheduleReconnect = function () {
    if (this.reconnectTimer) return;

    var delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    // Add jitter
    delay = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  };

  KCodeWebUI.prototype.setConnectionStatus = function (status) {
    var el = this.els.connectionStatus;
    el.className = "status-dot " + status;
    el.title =
      status === "connected"
        ? "Connected"
        : status === "connecting"
          ? "Connecting..."
          : "Disconnected";
  };

  KCodeWebUI.prototype.send = function (event) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  };

  // ─── Server Event Handling ────────────────────────────────────

  KCodeWebUI.prototype.handleServerEvent = function (event) {
    switch (event.type) {
      case "connected":
        this.sessionModel = event.model || "--";
        this.els.modelName.textContent = this.sessionModel;
        break;

      case "message.new":
        this.addMessage(event);
        break;

      case "message.delta":
        this.appendToMessage(event.id, event.delta);
        break;

      case "message.thinking":
        this.appendThinking(event.id, event.thinking);
        break;

      case "tool.start":
        this.showToolStart(event);
        break;

      case "tool.result":
        this.showToolResult(event);
        break;

      case "permission.request":
        this.showPermissionDialog(event);
        break;

      case "permission.resolved":
        this.hidePermissionDialog(event.id);
        break;

      case "session.stats":
        this.updateStats(event);
        break;

      case "model.changed":
        this.sessionModel = event.model;
        this.els.modelName.textContent = event.model;
        break;

      case "compact.start":
        this.showNotification("Compacting context (" + event.tokensBefore + " tokens)...");
        break;

      case "compact.done":
        this.showNotification(
          "Context compacted to " + event.tokensAfter + " tokens (" + event.method + ")",
        );
        break;

      case "error":
        this.showError(event.message);
        break;

      default:
        break;
    }
  };

  // ─── Message Rendering ────────────────────────────────────────

  KCodeWebUI.prototype.addMessage = function (msg) {
    // Remove welcome message
    if (this.els.welcomeMessage) {
      this.els.welcomeMessage.remove();
      this.els.welcomeMessage = null;
    }

    var el = document.createElement("div");
    el.className = "message " + msg.role;
    el.id = "message-" + msg.id;
    el.dataset.messageId = msg.id;

    var header = document.createElement("div");
    header.className = "message-header";

    var role = document.createElement("span");
    role.className = "message-role";
    role.textContent = msg.role === "user" ? "You" : "KCode";
    header.appendChild(role);

    if (msg.timestamp) {
      var time = document.createElement("span");
      time.textContent = new Date(msg.timestamp).toLocaleTimeString();
      header.appendChild(time);
    }

    el.appendChild(header);

    var body = document.createElement("div");
    body.className = "message-body";

    if (msg.content) {
      body.innerHTML = window.MarkdownRenderer.renderMarkdown(msg.content);
    }

    el.appendChild(body);
    this.els.messages.appendChild(el);

    // Track state
    this.messages.push({
      id: msg.id,
      role: msg.role,
      content: msg.content || "",
      el: el,
      bodyEl: body,
    });

    // If this is an assistant message with empty content, it's a stream start
    if (msg.role === "assistant" && !msg.content) {
      this.currentStreamId = msg.id;
      this.currentStreamEl = body;
      this.currentStreamText = "";
      this.setStreaming(true);
    }

    this.scrollToBottom();
  };

  KCodeWebUI.prototype.appendToMessage = function (id, delta) {
    if (this.currentStreamId === id && this.currentStreamEl) {
      this.currentStreamText += delta;
      // Re-render full markdown each time for correctness
      // (streaming deltas may break partial markdown)
      this.currentStreamEl.innerHTML = window.MarkdownRenderer.renderMarkdown(
        this.currentStreamText,
      );
      this.scrollToBottom();

      // Update stored message
      var msg = this.findMessage(id);
      if (msg) {
        msg.content = this.currentStreamText;
      }
    }
  };

  KCodeWebUI.prototype.appendThinking = function (id, thinking) {
    var messageEl = document.getElementById("message-" + id);
    if (!messageEl) return;

    var bodyEl = messageEl.querySelector(".message-body");
    if (!bodyEl) return;

    // Find or create thinking block
    var thinkingEl = bodyEl.querySelector(".thinking-block");
    if (!thinkingEl) {
      var toggle = document.createElement("div");
      toggle.className = "thinking-toggle";
      toggle.textContent = "Thinking...";
      toggle.addEventListener("click", () => {
        var block = toggle.nextElementSibling;
        if (block) {
          block.style.display = block.style.display === "none" ? "block" : "none";
          toggle.textContent = block.style.display === "none" ? "Show thinking" : "Hide thinking";
        }
      });

      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking-block";
      thinkingEl.textContent = thinking;

      // Insert before the main body content
      bodyEl.insertBefore(thinkingEl, bodyEl.firstChild);
      bodyEl.insertBefore(toggle, thinkingEl);
    } else {
      thinkingEl.textContent += thinking;
    }

    this.scrollToBottom();
  };

  KCodeWebUI.prototype.findMessage = function (id) {
    for (var i = 0; i < this.messages.length; i++) {
      if (this.messages[i].id === id) return this.messages[i];
    }
    return null;
  };

  // ─── Tool Execution Display ───────────────────────────────────

  KCodeWebUI.prototype.showToolStart = function (event) {
    var messageEl = document.getElementById("message-" + event.messageId);
    if (!messageEl) return;

    var bodyEl = messageEl.querySelector(".message-body");
    if (!bodyEl) return;

    var toolEl = document.createElement("div");
    toolEl.className = "tool-execution";
    toolEl.id = "tool-" + event.id;

    var header = document.createElement("div");
    header.className = "tool-header";
    header.addEventListener("click", () => {
      toolEl.classList.toggle("expanded");
    });

    var nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = event.name;
    header.appendChild(nameSpan);

    var statusSpan = document.createElement("span");
    statusSpan.className = "tool-status";
    statusSpan.textContent = "Running...";
    header.appendChild(statusSpan);

    var expandIcon = document.createElement("span");
    expandIcon.className = "tool-expand-icon";
    expandIcon.textContent = "\u25B6"; // right triangle
    header.appendChild(expandIcon);

    toolEl.appendChild(header);

    var toolBody = document.createElement("div");
    toolBody.className = "tool-body";
    if (event.input && Object.keys(event.input).length > 0) {
      toolBody.textContent = "Input: " + JSON.stringify(event.input, null, 2);
    }
    toolEl.appendChild(toolBody);

    bodyEl.appendChild(toolEl);
    this.scrollToBottom();
  };

  KCodeWebUI.prototype.showToolResult = function (event) {
    var toolEl = document.getElementById("tool-" + event.id);
    if (!toolEl) return;

    var statusSpan = toolEl.querySelector(".tool-status");
    if (statusSpan) {
      if (event.isError) {
        statusSpan.className = "tool-status error";
        statusSpan.textContent = "Error";
      } else {
        statusSpan.className = "tool-status success";
        var durationText = event.durationMs ? " (" + event.durationMs + "ms)" : "";
        statusSpan.textContent = "Done" + durationText;
      }
    }

    var toolBody = toolEl.querySelector(".tool-body");
    if (toolBody && event.result) {
      var resultText = event.result;
      // Truncate very long results in the UI
      if (resultText.length > 5000) {
        resultText =
          resultText.slice(0, 5000) + "\n... (" + (resultText.length - 5000) + " chars truncated)";
      }
      toolBody.textContent += "\n\nResult:\n" + resultText;
    }

    // Finalize streaming if this was the last event
    if (this.isStreaming) {
      // Keep streaming — more content may follow
    }

    this.scrollToBottom();
  };

  // ─── Permission Dialog ────────────────────────────────────────

  KCodeWebUI.prototype.showPermissionDialog = function (event) {
    this.permissionRequests.set(event.id, event);

    this.els.permissionDescription.textContent = event.description || "Tool: " + event.tool;
    this.els.permissionDetails.textContent = JSON.stringify(event.input, null, 2);
    this.els.permissionOverlay.classList.remove("hidden");

    // Store current permission ID for response
    this.els.permissionOverlay.dataset.permissionId = event.id;
  };

  KCodeWebUI.prototype.hidePermissionDialog = function (id) {
    var current = this.els.permissionOverlay.dataset.permissionId;
    if (current === id || !id) {
      this.els.permissionOverlay.classList.add("hidden");
    }
    this.permissionRequests.delete(id);
  };

  KCodeWebUI.prototype.respondPermission = function (action) {
    var id = this.els.permissionOverlay.dataset.permissionId;
    if (!id) return;

    this.send({ type: "permission.respond", id: id, action: action });
    this.hidePermissionDialog(id);
  };

  // ─── Stats ────────────────────────────────────────────────────

  KCodeWebUI.prototype.updateStats = function (stats) {
    if (stats.model) {
      this.sessionModel = stats.model;
      this.els.modelName.textContent = stats.model;
    }

    var totalTokens = (stats.inputTokens || 0) + (stats.outputTokens || 0);
    this.els.tokenCount.textContent = this.formatNumber(totalTokens) + " tokens";

    if (typeof stats.costUsd === "number") {
      this.els.costDisplay.textContent =
        stats.costUsd < 0.01 && stats.costUsd > 0
          ? "$" + stats.costUsd.toFixed(4)
          : "$" + stats.costUsd.toFixed(2);
    }

    // End streaming when stats arrive (means turn is done)
    this.setStreaming(false);
  };

  // ─── Input Handling ───────────────────────────────────────────

  KCodeWebUI.prototype.handleInputKeydown = function (e) {
    // Enter to send (without shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
      return;
    }

    // Up arrow for history
    if (e.key === "ArrowUp" && this.els.messageInput.value === "") {
      e.preventDefault();
      this.navigateHistory(-1);
      return;
    }

    // Down arrow for history
    if (e.key === "ArrowDown" && this.inputHistoryIndex >= 0) {
      e.preventDefault();
      this.navigateHistory(1);
      return;
    }
  };

  KCodeWebUI.prototype.sendMessage = function () {
    var text = this.els.messageInput.value.trim();
    if (!text) return;

    if (!this.connected) {
      this.showError("Not connected to server.");
      return;
    }

    // Add to history
    if (
      this.inputHistory.length === 0 ||
      this.inputHistory[this.inputHistory.length - 1] !== text
    ) {
      this.inputHistory.push(text);
      if (this.inputHistory.length > INPUT_HISTORY_MAX) {
        this.inputHistory.shift();
      }
    }
    this.inputHistoryIndex = -1;
    this.inputDraft = "";

    // Detect slash commands
    if (text.startsWith("/")) {
      this.send({ type: "command.run", command: text });
    } else {
      this.send({ type: "message.send", content: text });
    }

    // Clear input
    this.els.messageInput.value = "";
    this.autoResizeInput();
    this.updateCharCount();
  };

  KCodeWebUI.prototype.cancelMessage = function () {
    this.send({ type: "message.cancel" });
    this.setStreaming(false);
  };

  KCodeWebUI.prototype.navigateHistory = function (direction) {
    if (this.inputHistory.length === 0) return;

    if (this.inputHistoryIndex === -1) {
      this.inputDraft = this.els.messageInput.value;
    }

    this.inputHistoryIndex += direction;

    if (this.inputHistoryIndex < 0) {
      this.inputHistoryIndex = -1;
      this.els.messageInput.value = this.inputDraft;
    } else if (this.inputHistoryIndex >= this.inputHistory.length) {
      this.inputHistoryIndex = this.inputHistory.length - 1;
    } else {
      this.els.messageInput.value =
        this.inputHistory[this.inputHistory.length - 1 - this.inputHistoryIndex];
    }

    this.autoResizeInput();
    this.updateCharCount();
  };

  KCodeWebUI.prototype.autoResizeInput = function () {
    var el = this.els.messageInput;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  KCodeWebUI.prototype.updateCharCount = function () {
    var count = this.els.messageInput.value.length;
    this.els.charCount.textContent = count + " chars";
  };

  // ─── Streaming State ──────────────────────────────────────────

  KCodeWebUI.prototype.setStreaming = function (streaming) {
    this.isStreaming = streaming;

    if (streaming) {
      this.els.streamingIndicator.classList.remove("hidden");
      this.els.sendBtn.classList.add("hidden");
      this.els.cancelBtn.classList.remove("hidden");
    } else {
      this.els.streamingIndicator.classList.add("hidden");
      this.els.sendBtn.classList.remove("hidden");
      this.els.cancelBtn.classList.add("hidden");
      this.currentStreamId = null;
      this.currentStreamEl = null;
      this.currentStreamText = "";
    }
  };

  // ─── Scrolling ────────────────────────────────────────────────

  KCodeWebUI.prototype.scrollToBottom = function () {
    if (!this.autoScroll) return;
    var el = this.els.messages;
    // Use requestAnimationFrame for smooth scrolling
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  };

  // ─── Search ───────────────────────────────────────────────────

  KCodeWebUI.prototype.openSearch = function () {
    this.searchActive = true;
    this.els.searchBar.classList.remove("hidden");
    this.els.searchInput.focus();
  };

  KCodeWebUI.prototype.closeSearch = function () {
    this.searchActive = false;
    this.els.searchBar.classList.add("hidden");
    this.els.searchInput.value = "";
    this.clearSearchHighlights();
  };

  KCodeWebUI.prototype.performSearch = function (query) {
    this.clearSearchHighlights();
    if (!query || query.length < 2) return;

    var queryLower = query.toLowerCase();
    var bodies = this.els.messages.querySelectorAll(".message-body");

    for (var i = 0; i < bodies.length; i++) {
      this.highlightText(bodies[i], queryLower);
    }
  };

  KCodeWebUI.prototype.highlightText = (el, query) => {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    for (var i = 0; i < textNodes.length; i++) {
      var textNode = textNodes[i];
      var text = textNode.textContent;
      var lowerText = text.toLowerCase();
      var idx = lowerText.indexOf(query);
      if (idx === -1) continue;

      // Split the text node and wrap the match
      var before = text.slice(0, idx);
      var match = text.slice(idx, idx + query.length);
      var after = text.slice(idx + query.length);

      var span = document.createElement("span");
      span.className = "search-highlight";
      span.textContent = match;

      var parent = textNode.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      parent.insertBefore(span, textNode);
      if (after) parent.insertBefore(document.createTextNode(after), textNode);
      parent.removeChild(textNode);
    }
  };

  KCodeWebUI.prototype.clearSearchHighlights = function () {
    var highlights = this.els.messages.querySelectorAll(".search-highlight");
    for (var i = 0; i < highlights.length; i++) {
      var hl = highlights[i];
      var parent = hl.parentNode;
      parent.replaceChild(document.createTextNode(hl.textContent), hl);
      parent.normalize();
    }
  };

  // ─── Theme ────────────────────────────────────────────────────

  KCodeWebUI.prototype.toggleTheme = function () {
    this.isDarkTheme = !this.isDarkTheme;
    if (this.isDarkTheme) {
      document.body.classList.remove("theme-light");
    } else {
      document.body.classList.add("theme-light");
    }
    this.els.themeToggle.textContent = this.isDarkTheme ? "\u263D" : "\u2600";
    try {
      localStorage.setItem("kcode-theme", this.isDarkTheme ? "dark" : "light");
    } catch (e) {
      /* ignore */
    }
  };

  KCodeWebUI.prototype.loadTheme = function () {
    try {
      var saved = localStorage.getItem("kcode-theme");
      if (saved === "light") {
        this.isDarkTheme = false;
        document.body.classList.add("theme-light");
        this.els.themeToggle.textContent = "\u2600";
      }
    } catch (e) {
      /* ignore */
    }
  };

  // ─── Notifications ────────────────────────────────────────────

  KCodeWebUI.prototype.showNotification = function (message) {
    var msgId = "notif-" + Date.now();
    this.addMessage({
      id: msgId,
      role: "assistant",
      content: "*" + message + "*",
      timestamp: Date.now(),
    });
  };

  KCodeWebUI.prototype.showError = function (message) {
    var msgId = "error-" + Date.now();
    var el = document.createElement("div");
    el.className = "message assistant";
    el.id = "message-" + msgId;

    var header = document.createElement("div");
    header.className = "message-header";
    var role = document.createElement("span");
    role.className = "message-role";
    role.textContent = "System";
    role.style.color = "var(--text-error)";
    header.appendChild(role);
    el.appendChild(header);

    var body = document.createElement("div");
    body.className = "message-body";
    body.style.borderLeft = "3px solid var(--accent-red)";
    body.textContent = message;
    el.appendChild(body);

    this.els.messages.appendChild(el);
    this.scrollToBottom();
  };

  // ─── Tab Navigation ───────────────────────────────────────────

  KCodeWebUI.prototype.initTabs = function () {
    var self = this;
    var tabs = document.querySelectorAll(".nav-tab");

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        self.switchTab(this.dataset.tab);
      });
    }
  };

  KCodeWebUI.prototype.switchTab = function (tabName) {
    if (this.activeTab === tabName) return;

    // Deactivate old tab
    var oldTab = document.querySelector('.nav-tab[data-tab="' + this.activeTab + '"]');
    var oldPanel = document.getElementById("panel-" + this.activeTab);
    if (oldTab) oldTab.classList.remove("active");
    if (oldPanel) oldPanel.classList.remove("active");

    // Destroy old dashboard component if leaving its tab
    this.destroyDashboardComponent(this.activeTab);

    // Activate new tab
    this.activeTab = tabName;
    var newTab = document.querySelector('.nav-tab[data-tab="' + tabName + '"]');
    var newPanel = document.getElementById("panel-" + tabName);
    if (newTab) newTab.classList.add("active");
    if (newPanel) newPanel.classList.add("active");

    // Initialize dashboard component for new tab
    this.initDashboardComponent(tabName);
  };

  KCodeWebUI.prototype.initDashboardComponent = function (tabName) {
    var panel = document.getElementById("panel-" + tabName);
    if (!panel) return;

    switch (tabName) {
      case "models":
        if (window.ModelDashboard) {
          this.modelDashboard = new window.ModelDashboard(panel, this.authToken);
          this.modelDashboard.init();
        }
        break;
      case "analytics":
        if (window.AnalyticsDashboard) {
          this.analyticsDashboard = new window.AnalyticsDashboard(panel, this.authToken);
          this.analyticsDashboard.init();
        }
        break;
      case "session":
        if (window.SessionViewer) {
          this.sessionViewer = new window.SessionViewer(panel, this.authToken);
          this.sessionViewer.init();
        }
        break;
      case "config":
        if (window.ConfigPanel) {
          this.configPanel = new window.ConfigPanel(panel, this.authToken);
          this.configPanel.init();
        }
        break;
    }
  };

  KCodeWebUI.prototype.destroyDashboardComponent = function (tabName) {
    switch (tabName) {
      case "models":
        if (this.modelDashboard) {
          this.modelDashboard.destroy();
          this.modelDashboard = null;
        }
        break;
      case "analytics":
        if (this.analyticsDashboard) {
          this.analyticsDashboard.destroy();
          this.analyticsDashboard = null;
        }
        break;
      case "session":
        if (this.sessionViewer) {
          this.sessionViewer.destroy();
          this.sessionViewer = null;
        }
        break;
      case "config":
        if (this.configPanel) {
          this.configPanel.destroy();
          this.configPanel = null;
        }
        break;
    }
  };

  // ─── Utilities ────────────────────────────────────────────────

  KCodeWebUI.prototype.formatNumber = (n) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  };

  // ─── Bootstrap ────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", () => {
    var app = new KCodeWebUI();
    app.init();

    // Expose for debugging
    window.__kcode = app;
  });
})();
