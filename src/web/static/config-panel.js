// KCode - Configuration Panel Component
// Shows current config (model, permissions, effort level) in read-only view.
// Redacts secrets. Fetches from /api/v1/config endpoint.

(() => {
  function ConfigPanel(containerEl, authToken) {
    this.container = containerEl;
    this.authToken = authToken;
    this.config = null;
    this.refreshInterval = null;
  }

  ConfigPanel.prototype.init = function () {
    this.render();
    this.fetchData();
    this.refreshInterval = setInterval(() => this.fetchData(), 20000);
  };

  ConfigPanel.prototype.destroy = function () {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  };

  ConfigPanel.prototype.fetchData = function () {
    var headers = {};
    if (this.authToken) {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    fetch("/api/v1/config", { headers: headers })
      .then((res) => res.json())
      .then((data) => {
        this.config = data;
        this.renderContent();
      })
      .catch((err) => {
        this.renderError("Failed to load config: " + err.message);
      });
  };

  ConfigPanel.prototype.render = function () {
    this.container.innerHTML = "";

    var wrapper = document.createElement("div");
    wrapper.className = "dashboard-panel config-panel";

    var title = document.createElement("h2");
    title.className = "dashboard-title";
    title.textContent = "Configuration";
    wrapper.appendChild(title);

    var note = document.createElement("div");
    note.className = "config-readonly-note";
    note.textContent = "Read-only view. Edit settings via kcode setup or settings.json.";
    wrapper.appendChild(note);

    var content = document.createElement("div");
    content.className = "dashboard-content";
    content.id = "config-panel-content";
    wrapper.appendChild(content);

    this.container.appendChild(wrapper);
    this.contentEl = content;
  };

  ConfigPanel.prototype.renderContent = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";

    if (!this.config) {
      var loading = document.createElement("div");
      loading.className = "dashboard-empty";
      loading.textContent = "Loading configuration...";
      this.contentEl.appendChild(loading);
      return;
    }

    var table = document.createElement("table");
    table.className = "config-table";

    var configFields = [
      { key: "model", label: "Model", sensitive: false },
      { key: "permissionMode", label: "Permission Mode", sensitive: false },
      { key: "effortLevel", label: "Effort Level", sensitive: false },
      { key: "maxTokens", label: "Max Tokens", sensitive: false },
      { key: "contextWindowSize", label: "Context Window", sensitive: false },
      { key: "compactThreshold", label: "Compact Threshold", sensitive: false },
      { key: "workingDirectory", label: "Working Directory", sensitive: false },
      { key: "theme", label: "Theme", sensitive: false },
      { key: "fallbackModel", label: "Fallback Model", sensitive: false },
      { key: "pro", label: "Pro", sensitive: false },
      // These should already be redacted server-side, but double-check
      { key: "apiKey", label: "API Key", sensitive: true },
      { key: "anthropicApiKey", label: "Anthropic API Key", sensitive: true },
      { key: "proKey", label: "Pro Key", sensitive: true },
    ];

    for (var i = 0; i < configFields.length; i++) {
      var field = configFields[i];
      var value = this.config[field.key];

      // Skip undefined fields
      if (value === undefined) continue;

      var row = document.createElement("tr");

      var labelCell = document.createElement("td");
      labelCell.className = "config-label";
      labelCell.textContent = field.label;
      row.appendChild(labelCell);

      var valueCell = document.createElement("td");
      valueCell.className = "config-value";

      if (field.sensitive && value) {
        valueCell.textContent = "***";
        valueCell.className += " config-redacted";
      } else if (typeof value === "boolean") {
        var badge = document.createElement("span");
        badge.className = "config-badge " + (value ? "config-badge-on" : "config-badge-off");
        badge.textContent = value ? "Enabled" : "Disabled";
        valueCell.appendChild(badge);
      } else if (value === null) {
        valueCell.textContent = "Not set";
        valueCell.className += " config-null";
      } else if (typeof value === "number") {
        valueCell.textContent = formatConfigNumber(value);
        valueCell.className += " config-number";
      } else {
        valueCell.textContent = String(value);
      }

      row.appendChild(valueCell);
      table.appendChild(row);
    }

    this.contentEl.appendChild(table);
  };

  ConfigPanel.prototype.renderError = function (msg) {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";
    var errEl = document.createElement("div");
    errEl.className = "dashboard-error";
    errEl.textContent = msg;
    this.contentEl.appendChild(errEl);
  };

  function formatConfigNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "K";
    if (n < 1 && n > 0) return n.toFixed(2);
    return String(n);
  }

  window.ConfigPanel = ConfigPanel;
})();
