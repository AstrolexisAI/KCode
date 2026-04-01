// KCode - Dashboard Components Tests
// Tests for ModelDashboard, AnalyticsDashboard, SessionViewer, ConfigPanel

import { describe, expect, test } from "bun:test";

// ─── Static JS Component Tests (vanilla JS logic) ─────────────────

describe("Dashboard Components — Static JS", () => {
  // Test ModelDashboard module structure
  describe("ModelDashboard", () => {
    test("model-dashboard.js exports valid JS", async () => {
      const file = Bun.file(
        new URL("../static/model-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("function ModelDashboard");
      expect(content).toContain("prototype.init");
      expect(content).toContain("prototype.destroy");
      expect(content).toContain("prototype.fetchData");
      expect(content).toContain("window.ModelDashboard");
    });

    test("model-dashboard.js fetches from /api/v1/models", async () => {
      const file = Bun.file(
        new URL("../static/model-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("/api/v1/models");
    });

    test("model-dashboard.js shows provider badges", async () => {
      const file = Bun.file(
        new URL("../static/model-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("model-provider-badge");
      expect(content).toContain("provider-");
    });
  });

  // Test AnalyticsDashboard module structure
  describe("AnalyticsDashboard", () => {
    test("analytics-dashboard.js exports valid JS", async () => {
      const file = Bun.file(
        new URL("../static/analytics-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("function AnalyticsDashboard");
      expect(content).toContain("prototype.init");
      expect(content).toContain("prototype.destroy");
      expect(content).toContain("window.AnalyticsDashboard");
    });

    test("analytics-dashboard.js fetches from /api/v1/stats", async () => {
      const file = Bun.file(
        new URL("../static/analytics-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("/api/v1/stats");
    });

    test("analytics-dashboard.js computes tool usage from messages", async () => {
      const file = Bun.file(
        new URL("../static/analytics-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("computeToolUsage");
      expect(content).toContain("[tool:");
    });

    test("analytics-dashboard.js renders CSS bar charts", async () => {
      const file = Bun.file(
        new URL("../static/analytics-dashboard.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("analytics-bar-inner");
      expect(content).toContain("style.width");
    });
  });

  // Test SessionViewer module structure
  describe("SessionViewer", () => {
    test("session-viewer.js exports valid JS", async () => {
      const file = Bun.file(
        new URL("../static/session-viewer.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("function SessionViewer");
      expect(content).toContain("prototype.init");
      expect(content).toContain("prototype.destroy");
      expect(content).toContain("window.SessionViewer");
    });

    test("session-viewer.js fetches from /api/v1/messages", async () => {
      const file = Bun.file(
        new URL("../static/session-viewer.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("/api/v1/messages");
    });

    test("session-viewer.js handles code blocks", async () => {
      const file = Bun.file(
        new URL("../static/session-viewer.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("sv-code-block");
      expect(content).toContain("<pre><code>");
    });

    test("session-viewer.js handles tool calls", async () => {
      const file = Bun.file(
        new URL("../static/session-viewer.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("sv-tool-call");
      expect(content).toContain("sv-tool-header");
      expect(content).toContain("expanded");
    });

    test("session-viewer.js supports pagination", async () => {
      const file = Bun.file(
        new URL("../static/session-viewer.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("offset");
      expect(content).toContain("limit");
      expect(content).toContain("Previous");
      expect(content).toContain("Next");
    });
  });

  // Test ConfigPanel module structure
  describe("ConfigPanel", () => {
    test("config-panel.js exports valid JS", async () => {
      const file = Bun.file(
        new URL("../static/config-panel.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("function ConfigPanel");
      expect(content).toContain("prototype.init");
      expect(content).toContain("prototype.destroy");
      expect(content).toContain("window.ConfigPanel");
    });

    test("config-panel.js fetches from /api/v1/config", async () => {
      const file = Bun.file(
        new URL("../static/config-panel.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("/api/v1/config");
    });

    test("config-panel.js redacts sensitive fields", async () => {
      const file = Bun.file(
        new URL("../static/config-panel.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("sensitive");
      expect(content).toContain("***");
      expect(content).toContain("config-redacted");
    });

    test("config-panel.js is read-only", async () => {
      const file = Bun.file(
        new URL("../static/config-panel.js", import.meta.url).pathname,
      );
      const content = await file.text();
      expect(content).toContain("Read-only");
      // Should NOT contain any POST or PUT fetch calls
      expect(content).not.toContain('method: "POST"');
      expect(content).not.toContain('method: "PUT"');
    });
  });
});

// ─── Integration Tests — Tab Navigation in index.html ──────────────

describe("Dashboard — Static Files Integration", () => {
  test("index.html includes all dashboard scripts", async () => {
    const file = Bun.file(
      new URL("../static/index.html", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain("model-dashboard.js");
    expect(content).toContain("analytics-dashboard.js");
    expect(content).toContain("session-viewer.js");
    expect(content).toContain("config-panel.js");
    expect(content).toContain("dashboard.css");
  });

  test("index.html has navigation tabs", async () => {
    const file = Bun.file(
      new URL("../static/index.html", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain('data-tab="chat"');
    expect(content).toContain('data-tab="models"');
    expect(content).toContain('data-tab="analytics"');
    expect(content).toContain('data-tab="session"');
    expect(content).toContain('data-tab="config"');
  });

  test("index.html has tab panels for each view", async () => {
    const file = Bun.file(
      new URL("../static/index.html", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain('id="panel-chat"');
    expect(content).toContain('id="panel-models"');
    expect(content).toContain('id="panel-analytics"');
    expect(content).toContain('id="panel-session"');
    expect(content).toContain('id="panel-config"');
  });

  test("index.html preserves existing chat functionality", async () => {
    const file = Bun.file(
      new URL("../static/index.html", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain('id="messages"');
    expect(content).toContain('id="message-input"');
    expect(content).toContain('id="send-btn"');
    expect(content).toContain('id="cancel-btn"');
    expect(content).toContain('id="permission-overlay"');
    expect(content).toContain("app.js");
    expect(content).toContain("markdown.js");
  });

  test("app.js has tab navigation wired in", async () => {
    const file = Bun.file(
      new URL("../static/app.js", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain("initTabs");
    expect(content).toContain("switchTab");
    expect(content).toContain("initDashboardComponent");
    expect(content).toContain("destroyDashboardComponent");
    expect(content).toContain("ModelDashboard");
    expect(content).toContain("AnalyticsDashboard");
    expect(content).toContain("SessionViewer");
    expect(content).toContain("ConfigPanel");
  });

  test("dashboard.css exists with required styles", async () => {
    const file = Bun.file(
      new URL("../static/dashboard.css", import.meta.url).pathname,
    );
    const content = await file.text();
    expect(content).toContain(".nav-tabs");
    expect(content).toContain(".nav-tab");
    expect(content).toContain(".tab-panel");
    expect(content).toContain(".dashboard-panel");
    expect(content).toContain(".model-active-card");
    expect(content).toContain(".analytics-cards");
    expect(content).toContain(".session-viewer-header");
    expect(content).toContain(".config-table");
  });
});

// ─── React Component Tests ─────────────────────────────────────────

describe("Dashboard Components — React TSX", () => {
  test("ModelDashboard.tsx exports component", async () => {
    const mod = await import("./ModelDashboard");
    expect(typeof mod.ModelDashboard).toBe("function");
  });

  test("AnalyticsDashboard.tsx exports component", async () => {
    const mod = await import("./AnalyticsDashboard");
    expect(typeof mod.AnalyticsDashboard).toBe("function");
  });

  test("SessionViewer.tsx exports component", async () => {
    const mod = await import("./SessionViewer");
    expect(typeof mod.SessionViewer).toBe("function");
  });

  test("ConfigPanel.tsx exports component", async () => {
    const mod = await import("./ConfigPanel");
    expect(typeof mod.ConfigPanel).toBe("function");
  });
});
