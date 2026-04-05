// Tests for ToolSearch — discover deferred tools
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../core/types";
import {
  addDeferredTool,
  clearDeferredTools,
  executeToolSearch,
  getDeferredToolCount,
  getDeferredToolNames,
  toolSearchDefinition,
} from "./tool-search";

const mockTool = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  input_schema: { type: "object", properties: {} },
});

beforeEach(() => {
  clearDeferredTools();
  addDeferredTool("SendEmail", mockTool("SendEmail", "Send an email via SMTP"));
  addDeferredTool("CreateIssue", mockTool("CreateIssue", "Create a GitHub issue"));
  addDeferredTool("SlackMessage", mockTool("SlackMessage", "Post a message to Slack"));
  addDeferredTool("ReadNotion", mockTool("ReadNotion", "Read a Notion page"));
});

afterEach(() => {
  clearDeferredTools();
});

describe("toolSearchDefinition", () => {
  test("has correct name", () => {
    expect(toolSearchDefinition.name).toBe("ToolSearch");
  });
});

describe("deferred tool registry", () => {
  test("tracks added tools", () => {
    expect(getDeferredToolCount()).toBe(4);
    expect(getDeferredToolNames()).toContain("SendEmail");
  });

  test("clear empties registry", () => {
    clearDeferredTools();
    expect(getDeferredToolCount()).toBe(0);
  });
});

describe("executeToolSearch — keyword search", () => {
  test("rejects empty query", async () => {
    const result = await executeToolSearch({ query: "" });
    expect(result.is_error).toBe(true);
  });

  test("finds tool by name match", async () => {
    const result = await executeToolSearch({ query: "email" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("SendEmail");
  });

  test("finds tool by description match", async () => {
    const result = await executeToolSearch({ query: "slack" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("SlackMessage");
  });

  test("returns no-match message when nothing found", async () => {
    const result = await executeToolSearch({ query: "xyzzzyyy" });
    expect(result.content).toContain("No tools matched");
  });

  test("respects max_results cap", async () => {
    const result = await executeToolSearch({ query: "the", max_results: 2 });
    expect(result.is_error).toBeFalsy();
  });

  test("returns empty state message when no deferred tools", async () => {
    clearDeferredTools();
    const result = await executeToolSearch({ query: "email" });
    expect(result.content).toContain("No deferred tools");
  });
});

describe("executeToolSearch — select mode", () => {
  test("select by exact name", async () => {
    const result = await executeToolSearch({ query: "select:SendEmail" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("SendEmail");
    expect(result.content).toContain("<functions>");
  });

  test("select multiple tools", async () => {
    const result = await executeToolSearch({ query: "select:SendEmail,SlackMessage" });
    expect(result.content).toContain("SendEmail");
    expect(result.content).toContain("SlackMessage");
  });

  test("case-insensitive name fallback", async () => {
    const result = await executeToolSearch({ query: "select:sendemail" });
    expect(result.content).toContain("SendEmail");
  });

  test("reports not-found tools", async () => {
    const result = await executeToolSearch({ query: "select:NonExistent" });
    expect(result.content).toContain("Not found");
    expect(result.content).toContain("NonExistent");
  });
});
