// KCode - Skill Execution Tool
// Allows the LLM to invoke slash commands (skills) programmatically

import type { ToolDefinition, ToolResult } from "../core/types";
import { builtinSkills } from "../core/builtin-skills";

export const skillDefinition: ToolDefinition = {
  name: "Skill",
  description:
    "Execute a KCode slash command (skill) by name. Use this to invoke built-in commands like /commit, /test, /build, etc. " +
    "Returns the skill's template for dispatch, or the result for builtin actions.",
  input_schema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name to invoke (e.g., 'commit', 'test', 'build', 'lint'). Do not include the leading slash.",
      },
      args: {
        type: "string",
        description: "Optional arguments to pass to the skill",
      },
    },
    required: ["skill"],
  },
};

export async function executeSkill(input: Record<string, unknown>): Promise<ToolResult> {
  const skillName = String(input.skill ?? "").trim().replace(/^\//, "");
  const args = String(input.args ?? "").trim();

  if (!skillName) {
    return { tool_use_id: "", content: "Error: skill name is required.", is_error: true };
  }

  // Find the skill by name or alias
  const skill = builtinSkills.find(
    (s) => s.name === skillName || s.aliases.includes(skillName),
  );

  if (!skill) {
    // List available skills as suggestion
    const available = builtinSkills
      .filter((s) => !s.template.startsWith("__builtin_"))
      .map((s) => s.name)
      .slice(0, 30)
      .join(", ");
    return {
      tool_use_id: "",
      content: `Error: Unknown skill "${skillName}". Available: ${available}`,
      is_error: true,
    };
  }

  // Expand the template with args
  let template = skill.template;

  // Replace Handlebars-style args
  if (args) {
    template = template.replace(/\{\{args\}\}/g, args);
    template = template.replace(/\{\{#if args\}\}([\s\S]*?)\{\{\/if\}\}/g, "$1");
    template = template.replace(/\{\{\^if args\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  } else {
    template = template.replace(/\{\{args\}\}/g, "");
    template = template.replace(/\{\{#if args\}\}[\s\S]*?\{\{\/if\}\}/g, "");
    template = template.replace(/\{\{\^if args\}\}([\s\S]*?)\{\{\/if\}\}/g, "$1");
  }

  // If the template is a builtin action marker, return it as-is
  // The conversation loop will handle dispatch
  if (template.startsWith("__builtin_")) {
    return {
      tool_use_id: "",
      content: `[Skill invoked: /${skill.name}${args ? " " + args : ""}]\nBuiltin action: ${template}`,
    };
  }

  // Return the expanded template as the skill prompt
  return {
    tool_use_id: "",
    content: `[Skill /${skill.name} expanded]\n\n${template.trim()}`,
  };
}
