// KCode - Auto-Test Detection Types

export interface TestDetection {
  sourceFile: string;
  testFiles: string[];
  command: string;
  framework: TestFramework;
  confidence: number;
}

export type TestFramework =
  | "bun"
  | "vitest"
  | "jest"
  | "pytest"
  | "go"
  | "cargo"
  | "mocha"
  | "unknown";

export interface TestRunResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
}

export interface AutoTestConfig {
  enabled: boolean;
  autoRun: boolean;
  frameworks?: TestFramework[];
}
