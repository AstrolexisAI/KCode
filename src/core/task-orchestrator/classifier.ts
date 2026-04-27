// KCode - Intent Classifier
//
// Translates human language → task type in microseconds.
// No LLM needed — regex + keyword matching. Fast and deterministic.

import type { ClassifiedTask, TaskType } from "./types";

interface Rule {
  type: TaskType;
  /** Keywords/patterns that trigger this task type */
  patterns: RegExp[];
  /** Base confidence when matched */
  confidence: number;
}

const RULES: Rule[] = [
  // ── Audit ────────────────────────────────────────
  {
    type: "audit",
    patterns: [
      /\b(?:audit|auditalo|auditar|security.?review|vulnerability|scan|vulnerabilidad)\b/i,
      /\b(?:busca?\s*(?:bugs?|errores|vulnerabilidades|fallos))\b/i,
      /\b(?:find\s*(?:bugs?|issues|vulnerabilities|security))\b/i,
      /\bcheck\s*(?:for\s*)?(?:bugs?|security|issues)\b/i,
    ],
    confidence: 0.95,
  },
  // ── Debug ────────────────────────────────────────
  {
    type: "debug",
    patterns: [
      /\b(?:debug|por\s*qu[eé]\s*(?:falla|no\s*funciona|error)|why\s*(?:does|is)\s*(?:\w+\s+)*(?:fail|crash|break|not\s*work))\b/i,
      /\b(?:fix\s*(?:the|this|el|la|ese)?\s*(?:bug|error|crash|issue|problema|fallo))\b/i,
      /\b(?:not\s*working|no\s*funciona|se\s*rompe|crashes?|falla|traceback|exception|stack\s*trace)\b/i,
      /\b(?:error\s*(?:in|en|on|at)|fails?\s*(?:when|with|at|on))\b/i,
      /\b(?:arregla|soluciona|repara|corrige)\b/i,
    ],
    confidence: 0.9,
  },
  // ── Web Creation (high confidence — specific keywords) ──
  {
    type: "implement" as TaskType,
    patterns: [
      /\b(?:create|build|make|crea|construye|haz)\s+(?:an?\s+)?(?:[\w-]+\s+)*(?:website|web\s*(?:site|app|page)|landing\s*(?:page)?|dashboard|blog|portfolio|tienda|store|shop|sitio\s*web|p[aá]gina\s*web|app|platform|plataforma|feed|board|panel|monitor)\b/i,
      /\b(?:saas|e-?commerce|crm|kanban|chat|lms|iot|social\s+(?:media\s+)?feed|admin\s+panel|project\s+manag|task\s+board|device\s+monitor|course\s+platform|messaging)\b/i,
    ],
    confidence: 0.95,
  },
  // ── Implement ────────────────────────────────────
  {
    type: "implement",
    patterns: [
      /\b(?:add|create|implement|build|make|genera|crea|agrega|implementa|construye)\s+(?:a|an|un|una|the|el|la)?\s*(?:\w+\s+)*(?:endpoint|api|route|function|class|component|page|feature|module|service|handler|función|clase|componente|página)\b/i,
      /\b(?:scaffold|boilerplate|starter|template|nueva?\s*(?:función|clase|componente|página))\b/i,
      /\b(?:write\s*(?:a|the)?\s*(?:function|class|module|script|test))\b/i,
      /\b(?:escribe|programa|desarrolla|codea)\b/i,
    ],
    confidence: 0.85,
  },
  // ── Review ───────────────────────────────────────
  {
    type: "review",
    patterns: [
      /\b(?:review|revisa|analiza|evalua)\s*(?:this|the|el|la|ese)?\s*(?:code|PR|pull\s*request|commit|diff|cambios|código)\b/i,
      /\b(?:code\s*review|PR\s*review|revisar?\s*(?:código|PR))\b/i,
      /\bqué\s*(?:opinas|piensas)\s*(?:de|del|sobre)\b/i,
      /\b(?:look\s*at|check|examine)\s*(?:this|the)\s*(?:code|changes|diff)\b/i,
    ],
    confidence: 0.85,
  },
  // ── Refactor ─────────────────────────────────────
  {
    type: "refactor",
    patterns: [
      /\b(?:refactor|refactoriza|clean\s*up|limpia|simplifica|optimiza|optimize|improve|mejora)\b/i,
      /\b(?:split|extract|move|rename|reorganize|restructure)\s+(?:this|the|el|la)?\s*(?:function|class|file|module|method)\b/i,
      /\b(?:too\s*(?:long|complex|messy)|muy\s*(?:largo|complejo|desordenado))\b/i,
    ],
    confidence: 0.8,
  },
  // ── Test ─────────────────────────────────────────
  {
    type: "test",
    patterns: [
      /\b(?:write|add|create|genera|crea|agrega)\s*(?:a\s*)?(?:unit\s*)?tests?\b/i,
      /\b(?:test|tests|testing|spec|specs)\s+(?:for|para|de|del)\b/i,
      /\b(?:increase|improve|boost)\s*(?:test\s*)?coverage\b/i,
      /\b(?:cubre|cobertura|pruebas?\s*(?:unitarias?|de\s*integración))\b/i,
    ],
    confidence: 0.85,
  },
  // ── Deploy ───────────────────────────────────────
  {
    type: "deploy",
    patterns: [
      /\b(?:deploy|deployment|desplegar|despliegue|publish|publicar|ship|release)\b/i,
      /\b(?:docker|kubernetes|k8s|CI\/CD|pipeline|github\s*actions|vercel|netlify)\b/i,
      /\b(?:push\s*to\s*(?:prod|production|staging)|subir?\s*a\s*(?:producción|staging))\b/i,
    ],
    confidence: 0.8,
  },
  // ── Explain ──────────────────────────────────────
  {
    type: "explain",
    patterns: [
      /\b(?:explain|explica|explicame|qué\s*(?:es|hace|significa)|what\s*(?:is|does)\s*(?:this|it))\b/i,
      /\b(?:how\s*does|cómo\s*funciona|para\s*qué\s*sirve)\b/i,
      /\b(?:understand|entender|comprendo)\b/i,
    ],
    confidence: 0.8,
  },
];

/**
 * Extract file paths mentioned in the user message.
 */
function extractFiles(msg: string): string[] {
  const files: string[] = [];
  // Match paths like src/foo.ts, ./bar.py, file.cpp, etc.
  const pathRe =
    /(?:^|\s)((?:\.\/|\.\.\/|\/|[a-zA-Z][\w-]*\/)*[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|cpp|c|h|hh|java|kt|swift|rb|php|cs|dart|scala|sql|vue|svelte))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(msg)) !== null) {
    files.push(m[1]!.trim());
  }
  return files;
}

/**
 * Extract error messages / stack traces from user message.
 */
function extractError(msg: string): string | undefined {
  // Look for common error patterns
  const patterns = [
    /(?:error|Error|ERROR)[:\s]+(.{10,200})/,
    /(?:traceback|Traceback)[:\s]+([\s\S]{10,500})/i,
    /(?:exception|Exception)[:\s]+(.{10,200})/,
    /(?:failed|FAILED)[:\s]+(.{10,200})/i,
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/**
 * Classify a user message into a task type.
 * Returns the best match with confidence score.
 * Falls back to "general" if nothing matches above threshold.
 */
export function classifyTask(message: string): ClassifiedTask {
  let best: ClassifiedTask = {
    type: "general",
    confidence: 0,
    entities: {},
    raw: message,
  };

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(message)) {
        if (rule.confidence > best.confidence) {
          best = {
            type: rule.type,
            confidence: rule.confidence,
            entities: {
              files: extractFiles(message),
              error: extractError(message),
            },
            raw: message,
          };
        }
        break; // one pattern match per rule is enough
      }
    }
  }

  // Boost confidence if files are mentioned
  if (best.entities.files && best.entities.files.length > 0 && best.confidence > 0) {
    best.confidence = Math.min(1, best.confidence + 0.05);
  }

  return best;
}
