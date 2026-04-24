// Tests for AskUser tool — structured user questions
import { beforeEach, describe, expect, test } from "bun:test";
import { getTaskScopeManager } from "../core/task-scope";
import { askUserDefinition, executeAskUser } from "./ask-user";

// v292: ask-user enriches 'context' with the grounded closeout when
// scope is in a failed/partial state. Legacy tests that don't set up
// scope need a reset so previous tests' scopes don't bleed through.
beforeEach(() => getTaskScopeManager().reset());

describe("askUserDefinition", () => {
  test("has correct name and required params", () => {
    expect(askUserDefinition.name).toBe("AskUser");
    expect(askUserDefinition.input_schema.required).toContain("question");
  });
});

describe("executeAskUser", () => {
  test("rejects empty question", async () => {
    const result = await executeAskUser({ question: "" });
    expect(result.is_error).toBe(true);
  });

  test("rejects whitespace-only question", async () => {
    const result = await executeAskUser({ question: "   " });
    expect(result.is_error).toBe(true);
  });

  test("formats simple question", async () => {
    const result = await executeAskUser({ question: "What's your name?" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("[USER_INPUT_REQUIRED]");
    expect(result.content).toContain("What's your name?");
  });

  test("includes context when provided", async () => {
    const result = await executeAskUser({
      question: "Proceed?",
      context: "This will delete the branch",
    });
    expect(result.content).toContain("Context: This will delete the branch");
  });

  test("formats multiple-choice question", async () => {
    const result = await executeAskUser({
      question: "Pick one",
      choices: ["option A", "option B", "option C"],
    });
    expect(result.content).toContain("Choices:");
    expect(result.content).toContain("1. option A");
    expect(result.content).toContain("2. option B");
    expect(result.content).toContain("3. option C");
  });

  test("marks default choice", async () => {
    const result = await executeAskUser({
      question: "Pick one",
      choices: ["yes", "no"],
      default_choice: "yes",
    });
    expect(result.content).toContain("yes (default)");
    expect(result.content).not.toContain("no (default)");
  });

  test("shows default without choices", async () => {
    const result = await executeAskUser({
      question: "Name?",
      default_choice: "Anonymous",
    });
    expect(result.content).toContain("Default: Anonymous");
  });
});
