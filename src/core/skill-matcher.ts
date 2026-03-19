// KCode - Skill Auto-Invocation Matcher
// Matches user messages against skill trigger patterns for automatic invocation

import type { SkillDefinition } from "./builtin-skills";

export interface SkillTrigger {
  pattern: string;
  type: "regex" | "contains" | "startsWith";
}

export interface AutoInvokeSkill extends SkillDefinition {
  triggers?: SkillTrigger[];
  autoInvoke?: boolean;
}

export function matchSkills(
  userMessage: string,
  skills: AutoInvokeSkill[],
): AutoInvokeSkill[] {
  const messageLower = userMessage.toLowerCase();
  const matched: AutoInvokeSkill[] = [];

  for (const skill of skills) {
    if (!skill.autoInvoke || !skill.triggers || skill.triggers.length === 0) {
      continue;
    }

    for (const trigger of skill.triggers) {
      if (matchesTrigger(messageLower, trigger)) {
        matched.push(skill);
        break;
      }
    }
  }

  return matched;
}

function matchesTrigger(message: string, trigger: SkillTrigger): boolean {
  switch (trigger.type) {
    case "regex": {
      try {
        const re = new RegExp(trigger.pattern, "i");
        return re.test(message);
      } catch {
        return false;
      }
    }
    case "contains":
      return message.includes(trigger.pattern.toLowerCase());
    case "startsWith":
      return message.startsWith(trigger.pattern.toLowerCase());
    default:
      return false;
  }
}
