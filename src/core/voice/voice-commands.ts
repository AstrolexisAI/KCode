// KCode - Voice Commands Parser
// Maps spoken phrases to actions and slash commands (bilingual: English + Spanish)

// ─── Types ─────────────────────────────────────────────────────

export interface VoiceCommand {
  type: "action" | "slash";
  /** For type="action": the action to perform (submit, cancel, newline, clear) */
  action?: string;
  /** For type="slash": the slash command to execute */
  command?: string;
  /** Any remaining text after the command phrase */
  text?: string;
}

// ─── Action Mappings ───────────────────────────────────────────

interface ActionMapping {
  patterns: RegExp[];
  action: string;
}

const ACTION_MAPPINGS: ActionMapping[] = [
  {
    action: "submit",
    patterns: [/^enviar$/i, /^send$/i, /^submit$/i, /^enviar mensaje$/i, /^send message$/i],
  },
  {
    action: "cancel",
    patterns: [/^cancelar$/i, /^cancel$/i, /^abort$/i, /^abortar$/i],
  },
  {
    action: "newline",
    patterns: [
      /^nuevo p[aá]rrafo$/i,
      /^new paragraph$/i,
      /^nueva l[ií]nea$/i,
      /^new line$/i,
      /^newline$/i,
    ],
  },
  {
    action: "clear",
    patterns: [/^borrar$/i, /^delete$/i, /^clear$/i, /^limpiar$/i, /^borrar todo$/i, /^clear all$/i],
  },
];

// ─── Slash Command Mappings ────────────────────────────────────

interface SlashMapping {
  patterns: RegExp[];
  command: string;
}

const SLASH_MAPPINGS: SlashMapping[] = [
  {
    command: "/commit",
    patterns: [/^ejecutar commit$/i, /^run commit$/i, /^hacer commit$/i, /^commit$/i],
  },
  {
    command: "/test",
    patterns: [/^ejecutar tests?$/i, /^run tests?$/i, /^correr tests?$/i],
  },
  {
    command: "/plan",
    patterns: [/^mostrar plan$/i, /^show plan$/i, /^ver plan$/i],
  },
  {
    command: "/compact",
    patterns: [/^compactar$/i, /^compact$/i, /^compactar conversaci[oó]n$/i],
  },
  {
    command: "/status",
    patterns: [/^mostrar estado$/i, /^show status$/i, /^estado$/i, /^status$/i],
  },
  {
    command: "/stats",
    patterns: [/^mostrar estad[ií]sticas$/i, /^show stats$/i, /^stats$/i],
  },
  {
    command: "/help",
    patterns: [/^ayuda$/i, /^help$/i, /^mostrar ayuda$/i, /^show help$/i],
  },
];

// ─── Parser ────────────────────────────────────────────────────

/**
 * Parse voice-transcribed text for special commands.
 * Returns a VoiceCommand if a known command phrase is detected, or null if the text
 * is regular speech that should be treated as user input.
 */
export function parseVoiceCommand(text: string): VoiceCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Check action commands first
  for (const mapping of ACTION_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(trimmed)) {
        return { type: "action", action: mapping.action };
      }
    }
  }

  // Check slash command mappings
  for (const mapping of SLASH_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(trimmed)) {
        return { type: "slash", command: mapping.command };
      }
    }
  }

  // Not a command — return null so the text is treated as regular input
  return null;
}
