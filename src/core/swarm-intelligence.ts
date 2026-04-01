// KCode - Swarm Intelligence
// Evolution of the basic swarm: specialized agents with roles, inter-agent
// conflict resolution, and collective learning via distillation.
//
// Agents are specialized by domain (frontend, backend, testing, security, docs)
// and communicate through a shared context bus.

import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export type AgentRole =
  | "frontend"
  | "backend"
  | "testing"
  | "security"
  | "devops"
  | "documentation"
  | "architect"
  | "general";

export interface SwarmAgent {
  id: string;
  role: AgentRole;
  model: string;
  /** System prompt specialization for this role */
  specialization: string;
  /** File patterns this agent is responsible for */
  filePatterns: string[];
  /** Priority (higher = gets conflicts resolved in their favor) */
  priority: number;
}

export interface SwarmMessage {
  fromAgent: string;
  toAgent: string | "broadcast";
  type: "proposal" | "review" | "conflict" | "resolution" | "complete";
  content: string;
  timestamp: number;
  /** Files this message concerns */
  files?: string[];
}

export interface ConflictResolution {
  file: string;
  conflictingAgents: string[];
  resolution: "merge" | "prefer-higher-priority" | "architect-decides" | "vote";
  resolvedBy: string;
  result: string;
}

export interface SwarmPlan {
  id: string;
  task: string;
  agents: SwarmAgent[];
  assignments: Array<{ agentId: string; subtask: string; files: string[] }>;
  status: "planning" | "executing" | "reviewing" | "resolving" | "complete";
}

export interface SwarmIntelligenceResult {
  plan: SwarmPlan;
  messages: SwarmMessage[];
  conflicts: ConflictResolution[];
  /** Collective learnings extracted from the swarm session */
  learnings: string[];
  totalDurationMs: number;
}

// ─── Default Agent Specializations ─────────────────────────────

export const DEFAULT_AGENT_SPECS: Record<AgentRole, { specialization: string; filePatterns: string[]; priority: number }> = {
  architect: {
    specialization: "You are the architect agent. Focus on system design, module boundaries, API contracts, and architectural decisions. Review proposals from other agents for consistency.",
    filePatterns: ["**/*.md", "**/types.ts", "**/index.ts"],
    priority: 10,
  },
  frontend: {
    specialization: "You are the frontend agent. Focus on UI components, styling, accessibility, and user experience. Work with React, CSS, and browser APIs.",
    filePatterns: ["src/ui/**", "src/web/**", "**/*.tsx", "**/*.css"],
    priority: 5,
  },
  backend: {
    specialization: "You are the backend agent. Focus on core logic, APIs, data processing, and server-side code. Ensure performance and correctness.",
    filePatterns: ["src/core/**", "src/tools/**", "src/enterprise/**"],
    priority: 5,
  },
  testing: {
    specialization: "You are the testing agent. Write and maintain tests. Ensure coverage for new code. Identify edge cases and regression risks.",
    filePatterns: ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**"],
    priority: 4,
  },
  security: {
    specialization: "You are the security agent. Review code for vulnerabilities: injection, XSS, SSRF, path traversal, secrets exposure. Flag unsafe patterns.",
    filePatterns: ["src/core/permissions*", "src/core/safety*", "src/enterprise/**"],
    priority: 8,
  },
  devops: {
    specialization: "You are the devops agent. Focus on build systems, CI/CD, deployment, monitoring, and infrastructure configuration.",
    filePatterns: ["build.ts", "scripts/**", "Dockerfile", "*.yml", "*.yaml"],
    priority: 3,
  },
  documentation: {
    specialization: "You are the documentation agent. Write clear, accurate documentation. Update READMEs, API docs, and inline comments.",
    filePatterns: ["**/*.md", "docs/**"],
    priority: 2,
  },
  general: {
    specialization: "You are a general-purpose agent. Handle tasks that don't fit other specializations.",
    filePatterns: ["**/*"],
    priority: 1,
  },
};

// ─── Swarm Intelligence Orchestrator ───────────────────────────

export class SwarmIntelligence {
  private agents: SwarmAgent[] = [];
  private messages: SwarmMessage[] = [];
  private conflicts: ConflictResolution[] = [];
  private learnings: string[] = [];

  /** Create a swarm agent with a specific role */
  addAgent(role: AgentRole, model: string, id?: string): SwarmAgent {
    const spec = DEFAULT_AGENT_SPECS[role];
    const agent: SwarmAgent = {
      id: id ?? `${role}-${this.agents.length}`,
      role,
      model,
      specialization: spec.specialization,
      filePatterns: spec.filePatterns,
      priority: spec.priority,
    };
    this.agents.push(agent);
    return agent;
  }

  /** Create a default swarm with common roles */
  createDefaultSwarm(model: string): SwarmAgent[] {
    this.addAgent("architect", model);
    this.addAgent("backend", model);
    this.addAgent("frontend", model);
    this.addAgent("testing", model);
    this.addAgent("security", model);
    return [...this.agents];
  }

  /** Plan task distribution across agents based on file patterns */
  planDistribution(
    task: string,
    files: string[],
  ): SwarmPlan {
    const assignments: SwarmPlan["assignments"] = [];

    // Assign files to agents based on patterns
    const assigned = new Set<string>();

    // Higher priority agents get first pick
    const sortedAgents = [...this.agents].sort((a, b) => b.priority - a.priority);

    for (const agent of sortedAgents) {
      const matching = files.filter((f) => {
        if (assigned.has(f)) return false;
        return agent.filePatterns.some((p) => matchPattern(p, f));
      });

      if (matching.length > 0) {
        assignments.push({
          agentId: agent.id,
          subtask: `${task} — focus on ${agent.role} aspects`,
          files: matching,
        });
        matching.forEach((f) => assigned.add(f));
      }
    }

    // Assign remaining unmatched files to general agent or first agent
    const unassigned = files.filter((f) => !assigned.has(f));
    if (unassigned.length > 0) {
      const generalAgent = this.agents.find((a) => a.role === "general") ?? this.agents[0];
      if (generalAgent) {
        const existing = assignments.find((a) => a.agentId === generalAgent.id);
        if (existing) {
          existing.files.push(...unassigned);
        } else {
          assignments.push({
            agentId: generalAgent.id,
            subtask: `${task} — remaining files`,
            files: unassigned,
          });
        }
      }
    }

    return {
      id: `swarm-${Date.now()}`,
      task,
      agents: [...this.agents],
      assignments,
      status: "planning",
    };
  }

  /** Record a message between agents */
  sendMessage(msg: SwarmMessage): void {
    this.messages.push(msg);
  }

  /**
   * Resolve a file conflict between agents.
   * Uses priority-based resolution by default.
   */
  resolveConflict(
    file: string,
    conflictingAgents: string[],
    method: ConflictResolution["resolution"] = "prefer-higher-priority",
  ): ConflictResolution {
    let resolvedBy = conflictingAgents[0]!;

    if (method === "prefer-higher-priority") {
      // Find the agent with highest priority
      const sorted = conflictingAgents
        .map((id) => this.agents.find((a) => a.id === id))
        .filter(Boolean)
        .sort((a, b) => b!.priority - a!.priority);
      resolvedBy = sorted[0]?.id ?? conflictingAgents[0]!;
    } else if (method === "architect-decides") {
      const architect = this.agents.find((a) => a.role === "architect");
      resolvedBy = architect?.id ?? conflictingAgents[0]!;
    }

    const resolution: ConflictResolution = {
      file,
      conflictingAgents,
      resolution: method,
      resolvedBy,
      result: `Conflict on ${file} resolved by ${resolvedBy} using ${method}`,
    };

    this.conflicts.push(resolution);
    return resolution;
  }

  /** Add a collective learning */
  addLearning(learning: string): void {
    this.learnings.push(learning);
  }

  /** Get the current state */
  getState(): {
    agents: SwarmAgent[];
    messageCount: number;
    conflictCount: number;
    learnings: string[];
  } {
    return {
      agents: [...this.agents],
      messageCount: this.messages.length,
      conflictCount: this.conflicts.length,
      learnings: [...this.learnings],
    };
  }

  /** Reset the swarm */
  reset(): void {
    this.agents = [];
    this.messages = [];
    this.conflicts = [];
    this.learnings = [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/** Simple glob-like pattern matching */
function matchPattern(pattern: string, filePath: string): boolean {
  if (pattern === "**/*") return true;

  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");

  return new RegExp(regex).test(filePath);
}
