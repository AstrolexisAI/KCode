// KCode - Debug Engine Types

export interface DebugContext {
  /** The file(s) the user mentioned or that contain the error */
  targetFiles: string[];
  /** Content of target files (truncated) */
  fileContents: Map<string, string>;
  /** Error patterns found in the files */
  errorPatterns: ErrorPattern[];
  /** Recent git changes to the target files */
  recentChanges: string;
  /** Git blame for the error lines */
  blame: string;
  /** Related test files */
  testFiles: string[];
  /** Test output (if tests were run) */
  testOutput?: string;
  /** Callers/importers of the target functions */
  callers: string[];
  /** Stack trace or error message from user */
  errorMessage?: string;
  /** Machine pre-diagnosis from behavior pattern matching */
  machineDiagnosis?: string;
}

export interface ErrorPattern {
  file: string;
  line: number;
  type: "try-catch" | "throw" | "error-log" | "todo-fixme" | "assert" | "return-null" | "exception";
  code: string;
}

export interface DebugDiagnosis {
  rootCause: string;
  file: string;
  line: number;
  explanation: string;
  suggestedFix: string;
  confidence: "high" | "medium" | "low";
}

export interface DebugResult {
  context: DebugContext;
  diagnosis?: DebugDiagnosis;
  fixApplied: boolean;
  testsPassed?: boolean;
  elapsedMs: number;
}
