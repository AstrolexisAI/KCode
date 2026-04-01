// KCode - Smart Templates Types

export interface Template {
  name: string;
  description: string;
  tags: string[];
  parameters: TemplateParam[];
  prompt: string;
  postSetup?: string[];
  source: "builtin" | "user" | "project";
  filePath?: string;
}

export interface TemplateParam {
  name: string;
  description: string;
  type: "string" | "boolean" | "choice";
  choices?: string[];
  default?: string | boolean;
  required: boolean;
}

export interface ScaffoldResult {
  filesCreated: number;
  outputDir: string;
  files: Array<{ path: string; size: number }>;
  postSetupResults: Array<{ command: string; success: boolean }>;
}

export interface TemplateListItem {
  name: string;
  description: string;
  tags: string[];
  source: "builtin" | "user" | "project";
  parameterCount: number;
}
