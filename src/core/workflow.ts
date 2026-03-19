// KCode - Multi-Phase Workflow Engine
// Defines structured workflows with phases, agent spawning, and user confirmations.

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowPhase {
  /** Phase number (1-based) */
  id: number;
  /** Short phase name (e.g., "Discovery") */
  name: string;
  /** What this phase does */
  description: string;
  /** Agent names to spawn during this phase (from src/agents/ or ~/.kcode/agents/) */
  agents?: string[];
  /** Whether to pause and ask the user before proceeding */
  requiresConfirmation: boolean;
  /** Prompt template — supports {{context}} placeholders */
  prompt: string;
}

export interface Workflow {
  /** Workflow name (e.g., "feature-dev") */
  name: string;
  /** Ordered list of phases */
  phases: WorkflowPhase[];
  /** Index of the current phase (0-based into phases array) */
  currentPhase: number;
  /** Accumulated context from previous phases, keyed by phase name */
  context: Record<string, string>;
  /** Whether the workflow has completed all phases */
  completed: boolean;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a new workflow instance.
 */
export function createWorkflow(name: string, phases: WorkflowPhase[]): Workflow {
  return {
    name,
    phases,
    currentPhase: 0,
    context: {},
    completed: false,
  };
}

// ─── Phase Navigation ───────────────────────────────────────────

/**
 * Get the current phase of the workflow.
 * Returns null if the workflow is completed.
 */
export function getCurrentPhase(workflow: Workflow): WorkflowPhase | null {
  if (workflow.completed || workflow.currentPhase >= workflow.phases.length) {
    return null;
  }
  return workflow.phases[workflow.currentPhase]!;
}

/**
 * Advance to the next phase, storing context from the current phase.
 * Returns the next phase, or null if the workflow is complete.
 */
export function advancePhase(
  workflow: Workflow,
  phaseOutput?: string,
): WorkflowPhase | null {
  const current = getCurrentPhase(workflow);
  if (!current) return null;

  // Store output from the completed phase
  if (phaseOutput) {
    workflow.context[current.name] = phaseOutput;
  }

  workflow.currentPhase++;

  if (workflow.currentPhase >= workflow.phases.length) {
    workflow.completed = true;
    return null;
  }

  return workflow.phases[workflow.currentPhase]!;
}

/**
 * Expand a phase's prompt template with accumulated workflow context.
 * Replaces {{context.PhaseName}} with that phase's stored output,
 * and {{args}} with provided user arguments.
 */
export function getPhasePrompt(
  phase: WorkflowPhase,
  context: Record<string, string>,
): string {
  let prompt = phase.prompt;

  // Replace {{context.PhaseName}} references
  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{{context.${key}}}`;
    prompt = prompt.replaceAll(placeholder, value);
  }

  // Replace {{allContext}} with a summary of all phase outputs
  if (prompt.includes("{{allContext}}")) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(context)) {
      parts.push(`### ${key}\n${value}`);
    }
    prompt = prompt.replaceAll("{{allContext}}", parts.join("\n\n"));
  }

  return prompt;
}

// ─── Progress Display ───────────────────────────────────────────

/**
 * Format a progress summary for the workflow.
 */
export function formatWorkflowProgress(workflow: Workflow): string {
  const lines: string[] = [
    `  Workflow: ${workflow.name}`,
    `  Progress: Phase ${workflow.currentPhase + 1} of ${workflow.phases.length}\n`,
  ];

  for (let i = 0; i < workflow.phases.length; i++) {
    const phase = workflow.phases[i]!;
    let marker: string;
    if (i < workflow.currentPhase) {
      marker = "[done]";
    } else if (i === workflow.currentPhase) {
      marker = "[>>]";
    } else {
      marker = "[  ]";
    }
    const agentInfo = phase.agents?.length
      ? ` (agents: ${phase.agents.join(", ")})`
      : "";
    lines.push(`  ${marker} Phase ${phase.id}: ${phase.name}${agentInfo}`);
    lines.push(`       ${phase.description}`);
  }

  if (workflow.completed) {
    lines.push("\n  Workflow completed.");
  }

  return lines.join("\n");
}

// ─── Feature Development Workflow Definition ────────────────────

/**
 * Create the feature-dev workflow phases.
 * This is the canonical 7-phase feature development workflow.
 */
export function createFeatureDevPhases(): WorkflowPhase[] {
  return [
    {
      id: 1,
      name: "Discovery",
      description: "Understand requirements and ask clarifying questions",
      requiresConfirmation: true,
      prompt: `You are in Phase 1: Discovery of the feature-dev workflow.

Your goal is to deeply understand what the user wants to build.

1. Analyze the feature request carefully.
2. Identify any ambiguities or missing details.
3. Ask 3-5 clarifying questions that would affect the implementation approach.
4. Summarize your understanding of the requirements.
5. List the key acceptance criteria.

Feature request: {{args}}

Be thorough but concise. The user will confirm before moving to the next phase.`,
    },
    {
      id: 2,
      name: "Exploration",
      description: "Analyze codebase to find similar features and trace implementations",
      agents: ["code-explorer"],
      requiresConfirmation: true,
      prompt: `You are in Phase 2: Exploration of the feature-dev workflow.

Use the Agent tool to spawn a "code-explorer" agent with this task:

"Analyze the codebase to support implementing a new feature. Requirements:
{{context.Discovery}}

Find:
1. Similar features or patterns already in the codebase
2. Key files that will need modification
3. Relevant interfaces, types, and APIs
4. How similar features were implemented (trace the call chain)
5. Any dependencies or constraints to be aware of

Report your findings in a structured format."

After the agent completes, summarize its findings and identify the most relevant patterns and files.`,
    },
    {
      id: 3,
      name: "Architecture",
      description: "Design 2-3 implementation approaches with trade-offs",
      agents: ["code-architect"],
      requiresConfirmation: true,
      prompt: `You are in Phase 3: Architecture of the feature-dev workflow.

Use the Agent tool to spawn a "code-architect" agent with this task:

"Design implementation approaches for a new feature.

Requirements:
{{context.Discovery}}

Codebase exploration findings:
{{context.Exploration}}

Provide:
1. Two or three distinct implementation approaches
2. For each approach:
   - Architecture overview (which files, which patterns)
   - Estimated complexity (number of files to create/modify)
   - Trade-offs (pros and cons)
   - Risk assessment
3. A clear recommendation with justification

Follow the existing code conventions and patterns found during exploration."

Present the approaches to the user and ask which one to proceed with.`,
    },
    {
      id: 4,
      name: "Implementation",
      description: "Write code following the chosen approach",
      requiresConfirmation: true,
      prompt: `You are in Phase 4: Implementation of the feature-dev workflow.

Implement the feature based on the chosen approach.

Requirements:
{{context.Discovery}}

Codebase context:
{{context.Exploration}}

Architecture decision:
{{context.Architecture}}

Guidelines:
1. Follow existing code conventions and patterns found during exploration.
2. Create new files only when necessary — prefer extending existing ones.
3. Write clean, well-typed TypeScript.
4. Add inline comments only where the logic is non-obvious.
5. Keep changes minimal and focused — do not refactor unrelated code.

Implement the feature now. Read each file before modifying it.`,
    },
    {
      id: 5,
      name: "Testing",
      description: "Write tests and run existing test suite",
      requiresConfirmation: true,
      prompt: `You are in Phase 5: Testing of the feature-dev workflow.

Write and run tests for the implemented feature.

Requirements:
{{context.Discovery}}

What was implemented:
{{context.Implementation}}

Steps:
1. Identify which test files need updates or creation.
2. Write unit tests covering:
   - Happy path scenarios
   - Edge cases and error handling
   - Integration with existing code
3. Run the existing test suite to check for regressions: bun test
4. Fix any failing tests.
5. Report test results.

Follow the project's existing test patterns and conventions.`,
    },
    {
      id: 6,
      name: "Review",
      description: "Quality and security review with confidence scoring",
      agents: ["code-reviewer"],
      requiresConfirmation: true,
      prompt: `You are in Phase 6: Review of the feature-dev workflow.

Use the Agent tool to spawn a "code-reviewer" agent with this task:

"Review the recently implemented feature for quality and security.

Run git diff to see all changes, then review for:
1. Bugs and logic errors
2. Security vulnerabilities (injection, path traversal, etc.)
3. KCODE.md compliance (coding conventions, patterns)
4. Performance issues
5. Missing error handling
6. Type safety issues

For each issue found, output a JSON block on its own line:
{\"confidence\": 0-100, \"category\": \"bug|security|style|performance|logic\", \"severity\": \"critical|high|medium|low\", \"file\": \"path\", \"line\": N, \"description\": \"...\", \"suggestion\": \"...\"}

Be thorough and calibrate confidence carefully. Only flag issues you are genuinely confident about."

After the agent completes, parse its output for scored issues and present a filtered report showing only issues with confidence >= 80%.
Address any critical or high-severity issues before proceeding.`,
    },
    {
      id: 7,
      name: "Documentation",
      description: "Update docs and add comments only where needed",
      requiresConfirmation: false,
      prompt: `You are in Phase 7: Documentation of the feature-dev workflow.

Finalize the feature by updating documentation.

What was implemented:
{{context.Implementation}}

Review findings:
{{context.Review}}

Steps:
1. Check if KCODE.md or CLAUDE.md needs updates to reflect the new feature.
2. Add JSDoc comments to any new public functions or interfaces that lack them.
3. Do NOT create new documentation files unless the user explicitly asked for them.
4. Do NOT add comments to obvious code — only document non-obvious behavior.
5. Provide a brief summary of all changes made across all phases.

Keep documentation minimal and accurate.`,
    },
  ];
}
