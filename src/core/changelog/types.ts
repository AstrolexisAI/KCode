// KCode - Changelog Generator Types

export type CommitType =
  | "feat"
  | "fix"
  | "docs"
  | "refactor"
  | "test"
  | "chore"
  | "perf"
  | "breaking"
  | "style"
  | "ci"
  | "build";

export interface ChangelogEntry {
  type: CommitType;
  scope?: string;
  description: string;
  hash: string;
  author: string;
  date: string;
  breaking: boolean;
}

export interface Changelog {
  version: string;
  date: string;
  entries: ChangelogEntry[];
  breaking: ChangelogEntry[];
  features: ChangelogEntry[];
  fixes: ChangelogEntry[];
  other: ChangelogEntry[];
  markdown: string;
}

export interface RawCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ChangelogOptions {
  since?: string;
  version?: string;
  useLlm?: boolean;
  cwd?: string;
}
