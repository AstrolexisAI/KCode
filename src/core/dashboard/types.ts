// KCode - Project Dashboard Types

export interface ProjectDashboard {
  project: {
    name: string;
    language: string;
    files: number;
    linesOfCode: number;
    lastCommit: string;
  };
  tests: {
    framework: string;
    total: number;
    passing: number;
    failing: number;
    coverage?: number;
    lastRun: string;
  };
  codeQuality: {
    todos: number;
    todoList: Array<{ file: string; line: number; text: string }>;
    longFunctions: number;
    duplicateCode: number;
    complexityScore: number;
  };
  activity: {
    sessionsLast7Days: number;
    tokensLast7Days: number;
    costLast7Days: number;
    topTools: Array<{ name: string; count: number }>;
    filesModifiedByAI: number;
  };
  dependencies: {
    total: number;
    outdated: number;
    vulnerable: number;
  };
}

export interface DashboardOptions {
  watch?: boolean;
  json?: boolean;
  web?: boolean;
  refreshInterval?: number;
}
