// KCode - AskUser Tool
// Structured user questions with optional choices

import type { ToolDefinition } from "../core/types";

export const askUserDefinition: ToolDefinition = {
  name: "AskUser",
  description:
    "Ask the user a structured question when you need clarification or a decision. " +
    "Supports free-form questions, multiple-choice, and yes/no prompts. " +
    "Use this instead of embedding questions in assistant text when you need " +
    "a clear, actionable response before proceeding.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of choices for the user to pick from",
      },
      default_choice: {
        type: "string",
        description: "Default choice if the user presses Enter without typing",
      },
      context: {
        type: "string",
        description: "Optional context to help the user understand why you are asking",
      },
    },
    required: ["question"],
  },
};

export async function executeAskUser(
  input: Record<string, unknown>,
): Promise<string> {
  const question = String(input.question ?? "");
  const choices = input.choices as string[] | undefined;
  const defaultChoice = input.default_choice as string | undefined;
  const context = input.context as string | undefined;

  if (!question.trim()) {
    return "Error: question is required";
  }

  const parts: string[] = [];

  if (context) {
    parts.push(`Context: ${context}\n`);
  }

  parts.push(`[USER_INPUT_REQUIRED]`);
  parts.push(`Question: ${question}`);

  if (choices && choices.length > 0) {
    parts.push(`\nChoices:`);
    for (let i = 0; i < choices.length; i++) {
      const marker = defaultChoice === choices[i] ? " (default)" : "";
      parts.push(`  ${i + 1}. ${choices[i]}${marker}`);
    }
  } else if (defaultChoice) {
    parts.push(`Default: ${defaultChoice}`);
  }

  return parts.join("\n");
}
