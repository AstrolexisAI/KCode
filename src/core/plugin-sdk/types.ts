// KCode - Plugin SDK Types

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  kcode: string;
  skills?: string[];
  hooks?: Record<string, HookEntry[]>;
  mcpServers?: Record<string, McpServerConfig>;
  outputStyles?: string[];
  agents?: string[];
}

export interface HookEntry {
  match?: Record<string, string>;
  action: string;
  command: string;
  args?: string[];
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginScaffoldConfig {
  name: string;
  description: string;
  author: string;
  license: string;
  components: PluginComponent[];
  language: "markdown" | "typescript";
}

export type PluginComponent = "skills" | "hooks" | "mcp" | "output-styles" | "agents";

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

export interface PluginTestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration: number;
  error?: string;
}

export interface PublishResult {
  name: string;
  version: string;
  sha256: string;
}

export interface DocsSection {
  title: string;
  content: string;
}
