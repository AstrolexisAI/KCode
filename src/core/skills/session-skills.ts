// KCode - Session management skills

import type { SkillDefinition } from "../builtin-skills";

export const sessionSkills: SkillDefinition[] = [
  {
    name: "help",
    description: "Show available commands and tips",
    aliases: ["?", "commands"],
    template: `__builtin_help__`,
  },
  {
    name: "export",
    description: "Export conversation to file (md/json/html/txt)",
    aliases: ["save", "save-chat", "transcript"],
    args: ["filename or format (md/json/html/txt, default: md)"],
    template: `__builtin_export__`,
  },
  {
    name: "stats",
    description: "Show usage statistics",
    aliases: [],
    template: `__builtin_stats__`,
  },
  {
    name: "doctor",
    description: "Check system health",
    aliases: ["health"],
    template: `__builtin_doctor__`,
  },
  {
    name: "clear",
    description: "Clear conversation",
    aliases: ["cls"],
    template: `__builtin_clear__`,
  },
  {
    name: "compact",
    description: "Compact conversation history",
    aliases: ["summarize"],
    template: `__builtin_compact__`,
  },
  {
    name: "rewind",
    description: "Manage conversation checkpoints and rewind state",
    aliases: ["rew"],
    args: ["list | <number> | last"],
    template: `__builtin_rewind__`,
  },
  {
    name: "changes",
    description: "Show all files modified in this session",
    aliases: ["changed", "modified"],
    args: [],
    template: `__builtin_changes__`,
  },
  {
    name: "fork",
    description: "Fork the conversation at a specific point",
    aliases: ["split"],
    args: ["message number (optional, forks at current point if empty)"],
    template: `__builtin_fork__`,
  },
  {
    name: "memory",
    description: "List, search, or manage memories",
    aliases: ["mem", "remember"],
    args: ["list | search <query> | show <filename> | delete <filename>"],
    template: `__builtin_memory__`,
  },
  {
    name: "branches",
    description: "Show conversation fork history as a visual tree",
    aliases: ["tree", "forks"],
    args: [],
    template: `__builtin_branches__`,
  },
  {
    name: "conv-branch",
    description: "Create, label, or manage conversation branches",
    aliases: ["fork"],
    args: ["[name]", "label <name>", "delete"],
    template: `__builtin_branch__`,
  },
  {
    name: "continue",
    description: "Load a conversation branch and continue from it",
    aliases: ["load-branch"],
    args: ["branchId"],
    template: `__builtin_continue__`,
  },
  {
    name: "compare",
    description: "Compare responses from two models side-by-side",
    aliases: ["ab", "versus"],
    args: ["model1 model2 prompt"],
    template: `__builtin_compare__`,
  },
  {
    name: "bookmark",
    description: "Set or list conversation bookmarks",
    aliases: ["bm", "mark"],
    args: ["label (set) | list | goto <label> | delete <label>"],
    template: `__builtin_bookmark__`,
  },
  {
    name: "analytics",
    description: "Show tool usage analytics for current session",
    aliases: ["metrics"],
    args: [],
    template: `__builtin_analytics__`,
  },
  {
    name: "insights",
    description: "Generate a comprehensive session analysis report",
    aliases: ["session-report", "analysis"],
    args: [],
    template: `Analyze the current conversation session and generate a comprehensive insights report. Review ALL messages in the conversation history and produce a structured report with these sections:

## Session Insights Report

1. **Summary Statistics**
   - Total conversation turns (count user messages and assistant responses)
   - Total tool calls made (count all tool_use blocks)
   - Session duration (note the time elapsed)

2. **Tool Usage Breakdown**
   - List each tool used and how many times
   - Identify the most frequently used tools
   - Note any tools that were called but returned errors

3. **Files Modified**
   - List all files that were created, edited, or written to
   - Note which files were modified most frequently

4. **Key Decisions Made**
   - Summarize the major decisions or changes made during the session
   - Note any architectural or design choices

5. **Errors Encountered**
   - List any errors that occurred (tool errors, build failures, etc.)
   - For each error, describe how it was resolved

6. **Workflow Patterns**
   - Note any repeated patterns (e.g., edit-test-fix cycles)
   - Identify if there were any stuck loops or retries

7. **Suggestions for Improvement**
   - Based on the session, suggest ways to be more efficient
   - Note any potential issues that weren't addressed
   - Recommend follow-up tasks

Format the report clearly with headers and bullet points. Be concise but thorough.`,
  },
  {
    name: "note",
    description: "Add a timestamped annotation to the session",
    aliases: ["annotate"],
    args: ["note text"],
    template: `__builtin_note__`,
  },
  {
    name: "chain",
    description: "Run multiple slash commands in sequence",
    aliases: ["seq", "multi"],
    args: ["cmd1 ; cmd2 ; cmd3"],
    template: `__builtin_chain__`,
  },
  {
    name: "alias",
    description: "Create, list, or remove custom command aliases",
    aliases: ["shortcut"],
    args: ["set <shortcut> <expansion> | list | remove <shortcut>"],
    template: `__builtin_alias__`,
  },
  {
    name: "replay",
    description: "Replay the current session step by step with timestamps",
    aliases: ["playback"],
    args: [],
    template: `__builtin_replay__`,
  },
  {
    name: "snapshot",
    description: "Capture a snapshot of the current session state",
    aliases: ["snap"],
    args: ["[json|markdown]"],
    template: `__builtin_snapshot__`,
  },
  {
    name: "snapshots",
    description: "List saved session snapshots",
    aliases: ["snapshot-list"],
    args: ["[limit] | diff <id1> <id2> | view <id>"],
    template: `__builtin_snapshots__`,
  },
  {
    name: "session-tags",
    description: "Manage session tags/labels",
    aliases: ["label", "session-tag"],
    args: ["add <tag> | remove <tag> (no args to list)"],
    template: `__builtin_session_tags__`,
  },
  {
    name: "rename",
    description: "Rename the current session",
    aliases: ["session-name", "title"],
    args: ["session name"],
    template: `__builtin_rename__`,
  },
];
