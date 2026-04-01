import { describe, expect, test } from "bun:test";
import {
  enforceNetworkPolicy,
  enforceWebhookPolicy,
  getAirGapNetworkPolicy,
  type PolicyConfig,
} from "./policy";

describe("network policy enforcement", () => {
  describe("enforceNetworkPolicy", () => {
    test("allows all hosts when no network policy is set", () => {
      const config: PolicyConfig = {};
      const result = enforceNetworkPolicy("https://api.openai.com/v1/chat", config);
      expect(result.allowed).toBe(true);
    });

    test("always allows localhost regardless of policy", () => {
      const config: PolicyConfig = {
        network: { blockedHosts: ["*"] },
      };
      expect(enforceNetworkPolicy("http://localhost:11434/api", config).allowed).toBe(true);
      expect(enforceNetworkPolicy("http://127.0.0.1:10091/v1", config).allowed).toBe(true);
      expect(enforceNetworkPolicy("http://[::1]:8080/health", config).allowed).toBe(true);
    });

    test("always allows LAN addresses regardless of policy", () => {
      const config: PolicyConfig = {
        network: { blockedHosts: ["*"] },
      };
      expect(enforceNetworkPolicy("http://192.168.1.100:8080", config).allowed).toBe(true);
      expect(enforceNetworkPolicy("http://10.0.0.5:11434", config).allowed).toBe(true);
      expect(enforceNetworkPolicy("http://172.16.0.1:9090", config).allowed).toBe(true);
    });

    test("blocks hosts matching blockedHosts patterns", () => {
      const config: PolicyConfig = {
        network: { blockedHosts: ["*.openai.com", "api.anthropic.com"] },
      };
      const result = enforceNetworkPolicy("https://api.openai.com/v1/chat", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    test("blocks exact host in blockedHosts", () => {
      const config: PolicyConfig = {
        network: { blockedHosts: ["api.anthropic.com"] },
      };
      const result = enforceNetworkPolicy("https://api.anthropic.com/v1/messages", config);
      expect(result.allowed).toBe(false);
    });

    test("allows hosts not in blockedHosts", () => {
      const config: PolicyConfig = {
        network: { blockedHosts: ["*.openai.com"] },
      };
      const result = enforceNetworkPolicy("https://api.anthropic.com/v1/messages", config);
      expect(result.allowed).toBe(true);
    });

    test("enforces allowlist when allowedHosts is set", () => {
      const config: PolicyConfig = {
        network: { allowedHosts: ["*.internal.acme.com", "registry.acme.com"] },
      };
      // Allowed
      expect(
        enforceNetworkPolicy("https://api.internal.acme.com/v1", config).allowed,
      ).toBe(true);
      expect(
        enforceNetworkPolicy("https://registry.acme.com/plugins", config).allowed,
      ).toBe(true);
      // Not in allowlist
      const blocked = enforceNetworkPolicy("https://api.openai.com/v1/chat", config);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain("not in the network allowlist");
    });

    test("blockedHosts takes precedence over allowedHosts", () => {
      const config: PolicyConfig = {
        network: {
          allowedHosts: ["*.acme.com"],
          blockedHosts: ["evil.acme.com"],
        },
      };
      expect(
        enforceNetworkPolicy("https://api.acme.com/v1", config).allowed,
      ).toBe(true);
      expect(
        enforceNetworkPolicy("https://evil.acme.com/exfil", config).allowed,
      ).toBe(false);
    });

    test("rejects invalid URLs", () => {
      const config: PolicyConfig = { network: { allowedHosts: ["*"] } };
      const result = enforceNetworkPolicy("not-a-url", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid URL");
    });

    test("glob wildcard * matches any subdomain", () => {
      const config: PolicyConfig = {
        network: { allowedHosts: ["*.kulvex.ai"] },
      };
      expect(
        enforceNetworkPolicy("https://api.kulvex.ai/validate", config).allowed,
      ).toBe(true);
      expect(
        enforceNetworkPolicy("https://marketplace.kulvex.ai/plugins", config).allowed,
      ).toBe(true);
      expect(
        enforceNetworkPolicy("https://kulvex.ai/home", config).allowed,
      ).toBe(false); // *.kulvex.ai requires a subdomain
    });
  });

  describe("enforceWebhookPolicy", () => {
    test("blocks all webhooks when allowWebhooks is false", () => {
      const config: PolicyConfig = {
        network: { allowWebhooks: false },
      };
      const result = enforceWebhookPolicy("https://hooks.slack.com/services/xxx", config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Webhooks are disabled");
    });

    test("allows webhooks when allowWebhooks is true and host is allowed", () => {
      const config: PolicyConfig = {
        network: { allowWebhooks: true },
      };
      const result = enforceWebhookPolicy("https://hooks.slack.com/services/xxx", config);
      expect(result.allowed).toBe(true);
    });

    test("enforces host restrictions on allowed webhooks", () => {
      const config: PolicyConfig = {
        network: {
          allowWebhooks: true,
          allowedHosts: ["*.internal.acme.com"],
        },
      };
      expect(
        enforceWebhookPolicy("https://hooks.internal.acme.com/notify", config).allowed,
      ).toBe(true);
      expect(
        enforceWebhookPolicy("https://hooks.slack.com/services/xxx", config).allowed,
      ).toBe(false);
    });
  });

  describe("getAirGapNetworkPolicy", () => {
    test("blocks all external hosts", () => {
      const policy = getAirGapNetworkPolicy();
      expect(policy.blockedHosts).toContain("*");
    });

    test("allows localhost patterns", () => {
      const policy = getAirGapNetworkPolicy();
      expect(policy.allowedHosts).toContain("localhost");
      expect(policy.allowedHosts).toContain("127.0.0.1");
    });

    test("disables webhooks", () => {
      const policy = getAirGapNetworkPolicy();
      expect(policy.allowWebhooks).toBe(false);
    });

    test("disables plugin network", () => {
      const policy = getAirGapNetworkPolicy();
      expect(policy.allowPluginNetwork).toBe(false);
    });

    test("air-gap policy blocks external URLs via enforceNetworkPolicy", () => {
      const config: PolicyConfig = { network: getAirGapNetworkPolicy() };
      // External blocked
      expect(
        enforceNetworkPolicy("https://api.openai.com/v1/chat", config).allowed,
      ).toBe(false);
      expect(
        enforceNetworkPolicy("https://github.com/repo", config).allowed,
      ).toBe(false);
      // Local allowed
      expect(
        enforceNetworkPolicy("http://localhost:11434/api", config).allowed,
      ).toBe(true);
      expect(
        enforceNetworkPolicy("http://192.168.1.100:8080", config).allowed,
      ).toBe(true);
    });
  });
});
