// Tests for MCP tool helpers — name parsing and definition factory
import { describe, expect, test } from "bun:test";
import {
  buildMcpToolName,
  isMcpTool,
  mcpToolDefinition,
  parseMcpToolName,
} from "./mcp-tools";

describe("isMcpTool", () => {
  test("identifies MCP-prefixed names", () => {
    expect(isMcpTool("mcp__slack__send_message")).toBe(true);
    expect(isMcpTool("mcp__github__create_issue")).toBe(true);
  });

  test("rejects non-prefixed names", () => {
    expect(isMcpTool("Read")).toBe(false);
    expect(isMcpTool("Grep")).toBe(false);
    expect(isMcpTool("my_mcp_tool")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isMcpTool("")).toBe(false);
  });
});

describe("parseMcpToolName", () => {
  test("parses valid MCP name", () => {
    const parsed = parseMcpToolName("mcp__slack__send_message");
    expect(parsed).toEqual({ serverName: "slack", toolName: "send_message" });
  });

  test("handles tool names with underscores", () => {
    const parsed = parseMcpToolName("mcp__github__create_pull_request");
    expect(parsed).toEqual({ serverName: "github", toolName: "create_pull_request" });
  });

  test("handles server names with dashes", () => {
    const parsed = parseMcpToolName("mcp__my-server__run_task");
    expect(parsed).toEqual({ serverName: "my-server", toolName: "run_task" });
  });

  test("returns null for non-MCP names", () => {
    expect(parseMcpToolName("Read")).toBe(null);
    expect(parseMcpToolName("")).toBe(null);
  });

  test("returns null when separator missing", () => {
    expect(parseMcpToolName("mcp__noseparator")).toBe(null);
  });
});

describe("buildMcpToolName", () => {
  test("builds name from server and tool", () => {
    expect(buildMcpToolName("slack", "send_message")).toBe("mcp__slack__send_message");
    expect(buildMcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  test("roundtrips with parseMcpToolName", () => {
    const name = buildMcpToolName("server-1", "tool_name");
    const parsed = parseMcpToolName(name);
    expect(parsed).toEqual({ serverName: "server-1", toolName: "tool_name" });
  });
});

describe("mcpToolDefinition", () => {
  test("creates definition with MCP-prefixed name", () => {
    const def = mcpToolDefinition("slack", {
      name: "send_message",
      description: "Send a slack message",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    });
    expect(def.name).toBe("mcp__slack__send_message");
    expect(def.description).toContain("[MCP: slack]");
    expect(def.description).toContain("Send a slack message");
  });

  test("provides default description when missing", () => {
    const def = mcpToolDefinition("srv", { name: "mytool" });
    expect(def.description).toContain("[MCP: srv]");
    expect(def.description).toContain("mytool");
  });

  test("uses default input schema when missing", () => {
    const def = mcpToolDefinition("srv", { name: "mytool" });
    expect(def.input_schema).toEqual({ type: "object", properties: {} });
  });

  test("preserves provided input schema", () => {
    const schema = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
    const def = mcpToolDefinition("srv", { name: "t", inputSchema: schema });
    expect(def.input_schema).toEqual(schema);
  });
});
