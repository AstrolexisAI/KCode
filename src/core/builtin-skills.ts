// KCode - Built-in skill definitions
// Default skills that ship with KCode

import type { SkillTrigger } from "./skill-matcher";

export interface SkillDefinition {
  name: string;
  description: string;
  aliases: string[];
  args?: string[];
  template: string;
  triggers?: SkillTrigger[];
  autoInvoke?: boolean;
  /** Source directory for Level 3 resource loading */
  sourceDir?: string;
}

import { codeSkills } from "./skills/code-skills";
import { configSkills } from "./skills/config-skills";
import { devSkills } from "./skills/dev-skills";
import { gitSkills } from "./skills/git-skills";
import { sessionSkills } from "./skills/session-skills";
import { testingSkills } from "./skills/testing-skills";
import { utilitySkills } from "./skills/utility-skills";

export const builtinSkills: SkillDefinition[] = [
  ...gitSkills,
  ...codeSkills,
  ...testingSkills,
  ...sessionSkills,
  ...configSkills,
  ...devSkills,
  ...utilitySkills,
];
