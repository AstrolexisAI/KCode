// KCode - Analytics Dashboard Component
// Shows session stats: tokens, cost, tool usage breakdown with CSS bar charts.
// Fetches from /api/v1/stats and /api/v1/tools endpoints.

(() => {
  function AnalyticsDashboard(containerEl, authToken) {
    this.container = containerEl;
    this.authToken = authToken;
    this.stats = null;
    this.toolUsage = {};
    this.refreshInterval = null;
  }

  AnalyticsDashboard.prototype.init = function () {
    this.render();
    this.fetchData();
    this.refreshInterval = setInterval(() => this.fetchData(), 10000);
  };

  AnalyticsDashboard.prototype.destroy = function () {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  };

  AnalyticsDashboard.prototype.fetchData = function () {
    var headers = {};
    if (this.authToken) {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    // Fetch stats
    fetch("/api/v1/stats", { headers: headers })
      .then((res) => res.json())
      .then((data) => {
        this.stats = data;
        this.renderContent();
      })
      .catch((err) => {
        this.renderError("Failed to load stats: " + err.message);
      });

    // Fetch messages to compute tool usage breakdown
    fetch("/api/v1/messages?limit=500", { headers: headers })
      .then((res) => res.json())
      .then((data) => {
        this.computeToolUsage(data.messages || []);
        this.renderContent();
      })
      .catch(() => {
        // Non-critical, ignore
      });
  };

  AnalyticsDashboard.prototype.computeToolUsage = function (messages) {
    var usage = {};
    for (var i = 0; i < messages.length; i++) {
      var content = messages[i].content || "";
      // Look for [tool: ToolName] patterns in serialized content
      var re = /\[tool:\s*(\w+)\]/g;
      var match;
      while ((match = re.exec(content)) !== null) {
        var name = match[1];
        usage[name] = (usage[name] || 0) + 1;
      }
    }
    this.toolUsage = usage;
  };

  AnalyticsDashboard.prototype.render = function () {
    this.container.innerHTML = "";

    var wrapper = document.createElement("div");
    wrapper.className = "dashboard-panel analytics-dashboard";

    var title = document.createElement("h2");
    title.className = "dashboard-title";
    title.textContent = "Analytics";
    wrapper.appendChild(title);

    var content = document.createElement("div");
    content.className = "dashboard-content";
    content.id = "analytics-dashboard-content";
    wrapper.appendChild(content);

    this.container.appendChild(wrapper);
    this.contentEl = content;
  };

  AnalyticsDashboard.prototype.renderContent = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";

    if (!this.stats) {
      var loading = document.createElement("div");
      loading.className = "dashboard-empty";
      loading.textContent = "Loading statistics...";
      this.contentEl.appendChild(loading);
      return;
    }

    // Stats cards
    var cardsRow = document.createElement("div");
    cardsRow.className = "analytics-cards";

    cardsRow.appendChild(createStatCard("Model", this.stats.model || "--", "model"));
    cardsRow.appendChild(
      createStatCard("Total Tokens", formatNumber(this.stats.totalTokens || 0), "tokens"),
    );
    cardsRow.appendChild(
      createStatCard("Input Tokens", formatNumber(this.stats.inputTokens || 0), "input"),
    );
    cardsRow.appendChild(
      createStatCard("Output Tokens", formatNumber(this.stats.outputTokens || 0), "output"),
    );
    cardsRow.appendChild(
      createStatCard("Cost", "$" + (this.stats.costUsd || 0).toFixed(4), "cost"),
    );

    this.contentEl.appendChild(cardsRow);

    // Turn costs chart
    if (this.stats.turnCosts && this.stats.turnCosts.length > 0) {
      var turnTitle = document.createElement("h3");
      turnTitle.className = "analytics-section-title";
      turnTitle.textContent = "Recent Turn Costs";
      this.contentEl.appendChild(turnTitle);

      var turnChart = document.createElement("div");
      turnChart.className = "analytics-turn-chart";

      var maxCost = 0;
      for (var t = 0; t < this.stats.turnCosts.length; t++) {
        var tc = this.stats.turnCosts[t];
        var val = typeof tc === "number" ? tc : tc.cost || tc.tokens || 0;
        if (val > maxCost) maxCost = val;
      }

      for (var t2 = 0; t2 < this.stats.turnCosts.length; t2++) {
        var tc2 = this.stats.turnCosts[t2];
        var val2 = typeof tc2 === "number" ? tc2 : tc2.cost || tc2.tokens || 0;
        var pct = maxCost > 0 ? (val2 / maxCost) * 100 : 0;

        var bar = document.createElement("div");
        bar.className = "analytics-bar-row";

        var label = document.createElement("span");
        label.className = "analytics-bar-label";
        label.textContent = "Turn " + (t2 + 1);
        bar.appendChild(label);

        var barOuter = document.createElement("div");
        barOuter.className = "analytics-bar-outer";

        var barInner = document.createElement("div");
        barInner.className = "analytics-bar-inner";
        barInner.style.width = pct + "%";
        barOuter.appendChild(barInner);
        bar.appendChild(barOuter);

        var valLabel = document.createElement("span");
        valLabel.className = "analytics-bar-value";
        valLabel.textContent =
          typeof val2 === "number" && val2 < 1 ? val2.toFixed(4) : formatNumber(val2);
        bar.appendChild(valLabel);

        turnChart.appendChild(bar);
      }

      this.contentEl.appendChild(turnChart);
    }

    // Tool usage breakdown
    var toolKeys = Object.keys(this.toolUsage);
    if (toolKeys.length > 0) {
      var toolTitle = document.createElement("h3");
      toolTitle.className = "analytics-section-title";
      toolTitle.textContent = "Tool Usage Breakdown";
      this.contentEl.appendChild(toolTitle);

      // Sort by count descending
      toolKeys.sort(
        function (a, b) {
          return this.toolUsage[b] - this.toolUsage[a];
        }.bind(this),
      );

      var maxCount = this.toolUsage[toolKeys[0]] || 1;

      var toolChart = document.createElement("div");
      toolChart.className = "analytics-tool-chart";

      for (var k = 0; k < toolKeys.length; k++) {
        var toolName = toolKeys[k];
        var count = this.toolUsage[toolName];
        var toolPct = (count / maxCount) * 100;

        var toolRow = document.createElement("div");
        toolRow.className = "analytics-bar-row";

        var toolLabel = document.createElement("span");
        toolLabel.className = "analytics-bar-label";
        toolLabel.textContent = toolName;
        toolRow.appendChild(toolLabel);

        var toolBarOuter = document.createElement("div");
        toolBarOuter.className = "analytics-bar-outer";

        var toolBarInner = document.createElement("div");
        toolBarInner.className = "analytics-bar-inner analytics-bar-tool";
        toolBarInner.style.width = toolPct + "%";
        toolBarOuter.appendChild(toolBarInner);
        toolRow.appendChild(toolBarOuter);

        var toolValLabel = document.createElement("span");
        toolValLabel.className = "analytics-bar-value";
        toolValLabel.textContent = count;
        toolRow.appendChild(toolValLabel);

        toolChart.appendChild(toolRow);
      }

      this.contentEl.appendChild(toolChart);
    }
  };

  AnalyticsDashboard.prototype.renderError = function (msg) {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";
    var errEl = document.createElement("div");
    errEl.className = "dashboard-error";
    errEl.textContent = msg;
    this.contentEl.appendChild(errEl);
  };

  function createStatCard(label, value, type) {
    var card = document.createElement("div");
    card.className = "analytics-stat-card stat-" + type;

    var valEl = document.createElement("div");
    valEl.className = "analytics-stat-value";
    valEl.textContent = value;
    card.appendChild(valEl);

    var labelEl = document.createElement("div");
    labelEl.className = "analytics-stat-label";
    labelEl.textContent = label;
    card.appendChild(labelEl);

    return card;
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  window.AnalyticsDashboard = AnalyticsDashboard;
})();
