// KCode - Model Dashboard Component
// Shows active model, registered models, and hardware info.
// Fetches from /api/v1/models endpoint.

(() => {
  function ModelDashboard(containerEl, authToken) {
    this.container = containerEl;
    this.authToken = authToken;
    this.models = [];
    this.activeModel = "--";
    this.refreshInterval = null;
  }

  ModelDashboard.prototype.init = function () {
    this.render();
    this.fetchData();
    this.refreshInterval = setInterval(() => this.fetchData(), 15000);
  };

  ModelDashboard.prototype.destroy = function () {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  };

  ModelDashboard.prototype.fetchData = function () {
    var headers = {};
    if (this.authToken) {
      headers["Authorization"] = "Bearer " + this.authToken;
    }

    fetch("/api/v1/models", { headers: headers })
      .then((res) => res.json())
      .then((data) => {
        this.models = data.models || [];
        this.activeModel = data.active || "--";
        this.renderContent();
      })
      .catch((err) => {
        this.renderError("Failed to load models: " + err.message);
      });
  };

  ModelDashboard.prototype.render = function () {
    this.container.innerHTML = "";

    var wrapper = document.createElement("div");
    wrapper.className = "dashboard-panel model-dashboard";

    var title = document.createElement("h2");
    title.className = "dashboard-title";
    title.textContent = "Models";
    wrapper.appendChild(title);

    var content = document.createElement("div");
    content.className = "dashboard-content";
    content.id = "model-dashboard-content";
    wrapper.appendChild(content);

    this.container.appendChild(wrapper);
    this.contentEl = content;
  };

  ModelDashboard.prototype.renderContent = function () {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";

    // Active model card
    var activeCard = document.createElement("div");
    activeCard.className = "model-active-card";

    var activeLabel = document.createElement("div");
    activeLabel.className = "model-active-label";
    activeLabel.textContent = "Active Model";
    activeCard.appendChild(activeLabel);

    var activeName = document.createElement("div");
    activeName.className = "model-active-name";
    activeName.textContent = this.activeModel;
    activeCard.appendChild(activeName);

    // Find provider for active model
    var activeEntry = null;
    for (var i = 0; i < this.models.length; i++) {
      if (this.models[i].id === this.activeModel || this.models[i].name === this.activeModel) {
        activeEntry = this.models[i];
        break;
      }
    }

    if (activeEntry) {
      var providerBadge = document.createElement("span");
      providerBadge.className =
        "model-provider-badge provider-" + (activeEntry.provider || "openai");
      providerBadge.textContent = activeEntry.provider || "openai";
      activeCard.appendChild(providerBadge);

      if (activeEntry.contextWindow) {
        var ctxSpan = document.createElement("span");
        ctxSpan.className = "model-context-size";
        ctxSpan.textContent = formatNumber(activeEntry.contextWindow) + " ctx";
        activeCard.appendChild(ctxSpan);
      }
    }

    this.contentEl.appendChild(activeCard);

    // Model list
    if (this.models.length > 0) {
      var listTitle = document.createElement("h3");
      listTitle.className = "model-list-title";
      listTitle.textContent = "Registered Models (" + this.models.length + ")";
      this.contentEl.appendChild(listTitle);

      var list = document.createElement("div");
      list.className = "model-list";

      for (var j = 0; j < this.models.length; j++) {
        var m = this.models[j];
        var row = document.createElement("div");
        row.className = "model-list-row";
        if (m.id === this.activeModel || m.name === this.activeModel) {
          row.className += " model-row-active";
        }

        var nameCol = document.createElement("span");
        nameCol.className = "model-row-name";
        nameCol.textContent = m.name || m.id;
        row.appendChild(nameCol);

        var provCol = document.createElement("span");
        provCol.className = "model-provider-badge provider-" + (m.provider || "openai");
        provCol.textContent = m.provider || "openai";
        row.appendChild(provCol);

        var statusCol = document.createElement("span");
        statusCol.className = "model-row-status";
        if (m.id === this.activeModel || m.name === this.activeModel) {
          statusCol.textContent = "active";
          statusCol.className += " status-active";
        } else {
          statusCol.textContent = "available";
          statusCol.className += " status-available";
        }
        row.appendChild(statusCol);

        if (m.contextWindow) {
          var ctxCol = document.createElement("span");
          ctxCol.className = "model-row-ctx";
          ctxCol.textContent = formatNumber(m.contextWindow);
          row.appendChild(ctxCol);
        }

        list.appendChild(row);
      }

      this.contentEl.appendChild(list);
    } else {
      var empty = document.createElement("div");
      empty.className = "dashboard-empty";
      empty.textContent = "No models registered. Use kcode models to configure.";
      this.contentEl.appendChild(empty);
    }
  };

  ModelDashboard.prototype.renderError = function (msg) {
    if (!this.contentEl) return;
    this.contentEl.innerHTML = "";
    var errEl = document.createElement("div");
    errEl.className = "dashboard-error";
    errEl.textContent = msg;
    this.contentEl.appendChild(errEl);
  };

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "K";
    return String(n);
  }

  window.ModelDashboard = ModelDashboard;
})();
