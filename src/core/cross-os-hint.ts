// KCode - Cross-OS command hint + auto-substitute
//
// Two-layer safety net for cross-OS command mismatches:
//
// LAYER 1 — Hint (deriveCrossOsHint): when a Bash command fails with
//   `command not found`, append a one-line `[cross-os-hint] RETRY NOW`
//   trailer to the tool result. Used for cases where the model must
//   pick a different command itself (e.g. install something first).
//
// LAYER 2 — Auto-substitute (deriveAutoSubstitute): for the subset of
//   mismatches where there's a clean 1:1 mapping that preserves
//   model intent (e.g. `ip addr` → `ifconfig`), return a substituted
//   command string for the Bash tool to run automatically. The model
//   sees the substituted command's output prefixed with a note that
//   the original was rewritten. This is the ONLY approach that works
//   for tool-following-weak models (Gemma, Qwen3-Coder), which were
//   verified 2026-05-08 to ignore even strongly-imperative
//   "[cross-os-hint] RETRY NOW" trailers and hallucinate "tools
//   restricted" instead of issuing the substituted command.
//
// Auto-substitute is gated to obvious equivalences only — never for
// install-required cases (brew install ...) and never for
// argument-incompatible substitutions (e.g. `stat -c` → `stat -f`).

// Tools that aren't OS-specific but are commonly missing on macOS without
// brew. Suggest the install command — the user authorizes via the normal
// permission flow; sudo isn't needed for `brew install`.
const MISSING_TOOL_INSTALL: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^nmap\b/,
    "`nmap` is not installed. Run `brew install nmap` first (no sudo needed; user approves via the permission prompt).",
  ],
  [/^arp-scan\b/, "`arp-scan` is not installed. Run `brew install arp-scan` first."],
  [
    /^netcat\b|^nc\s/,
    "BSD `nc` ships with macOS. If you need GNU `ncat`, run `brew install nmap` (provides ncat).",
  ],
  [/^iperf\d?\b/, "`iperf` is not installed. Run `brew install iperf3` first."],
  [
    /^tcpdump\b/,
    "`tcpdump` ships with macOS but needs sudo for packet capture. Try `sudo tcpdump …` (the permission system will prompt for the password).",
  ],
  [
    /^wireshark\b/,
    "Wireshark CLI is `tshark`. Run `brew install --cask wireshark` (full app) or `brew install wireshark` for tshark only.",
  ],
  [
    /^htop\b/,
    "`htop` is not installed. Run `brew install htop` first, or use built-in `top -o cpu`.",
  ],
  [/^tree\b/, "`tree` is not installed. Run `brew install tree` first."],
  [/^jq\b/, "`jq` is not installed. Run `brew install jq` first."],
  [/^yq\b/, "`yq` is not installed. Run `brew install yq` first."],
  [/^http\b/, "`http` (HTTPie) is not installed. Run `brew install httpie` first, or use `curl`."],
];

const LINUX_TO_MACOS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ip\s+(addr|a|address)\b/, "On macOS use `ifconfig` (no `ip` binary)"],
  [/^ip\s+(route|r)\b/, "On macOS use `netstat -rn` (no `ip route` here)"],
  [/^ip\s+link\b/, "On macOS use `ifconfig` or `networksetup -listallhardwareports`"],
  [/^ss\s+/, "On macOS use `lsof -nP -iTCP -sTCP:LISTEN` (no `ss` here)"],
  [
    /^nmcli\b/,
    "On macOS use `networksetup -listpreferredwirelessnetworks en0` or `system_profiler SPAirPortDataType`",
  ],
  [/^iw\s+(dev|wlan)/, "On macOS use `system_profiler SPAirPortDataType` for Wi-Fi info"],
  [/^iwconfig\b/, "On macOS use `networksetup -getairportnetwork en0` or `wdutil info`"],
  [/^iwgetid\b/, "On macOS use `networksetup -getairportnetwork en0`"],
  [/^apt(-get)?\s+/, "On macOS use `brew` (or `port` if MacPorts) — no apt/dpkg here"],
  [/^dpkg\b/, "On macOS use `brew list` to query installed Homebrew packages"],
  [/^yum\b/, "On macOS use `brew` — no yum here"],
  [/^pacman\b/, "On macOS use `brew` — no pacman here"],
  [/^systemctl\b/, "On macOS use `launchctl` (similar verbs: list, load, unload, kickstart)"],
  [/^journalctl\b/, "On macOS use `log show --predicate '...'` or open Console.app"],
  [/^xdg-open\b/, "On macOS use `open` (built-in URL/file opener)"],
  [/^xclip\b/, "On macOS use `pbcopy` (write) and `pbpaste` (read)"],
  [/^wl-(copy|paste)\b/, "On macOS use `pbcopy` / `pbpaste`"],
  [/^free\b/, "On macOS use `vm_stat` and `top -l 1 -s 0 | grep PhysMem`"],
  [/^lsb_release\b/, "On macOS use `sw_vers` (`-productName`, `-productVersion`, `-buildVersion`)"],
  [/^getconf\s+_NPROCESSORS_ONLN/, "On macOS use `sysctl -n hw.ncpu`"],
  [/^nproc\b/, "On macOS use `sysctl -n hw.ncpu`"],
  [/^stat\s+-c\s/, "On macOS BSD `stat` uses `-f` instead of `-c` (e.g. `stat -f '%z %m'`)"],
];

const MACOS_TO_LINUX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^networksetup\b/, "On Linux use `nmcli`, `iw`, or `ip` — no `networksetup`"],
  [/^ipconfig\s+getifaddr\b/, "On Linux use `ip -4 addr show <iface>` or `hostname -I`"],
  [/^system_profiler\b/, "On Linux use `lshw`, `inxi`, or read `/proc` and `/sys`"],
  [/^wdutil\b/, "On Linux use `iw dev <iface> link` or `nmcli`"],
  [/^pbcopy\b/, "On Linux use `xclip -selection clipboard` (X11) or `wl-copy` (Wayland)"],
  [/^pbpaste\b/, "On Linux use `xclip -o -selection clipboard` (X11) or `wl-paste` (Wayland)"],
  [/^launchctl\b/, "On Linux use `systemctl` (similar verbs: status, start, stop, enable)"],
  [/^say\b/, "On Linux there's no built-in `say` — use `espeak` or skip"],
  [/^osascript\b/, "On Linux there's no AppleScript — skip or use a shell-native equivalent"],
  [/^open\s+(?!\.|\/)/, "On Linux use `xdg-open` (note: `open` exists for fd-based use only)"],
  [/^sw_vers\b/, "On Linux use `lsb_release -a`, `cat /etc/os-release`, or `uname -a`"],
  [/^vm_stat\b/, "On Linux use `free -h` or read `/proc/meminfo`"],
  [/^sysctl\s+(-n\s+)?hw\.ncpu\b/, "On Linux use `nproc` or `getconf _NPROCESSORS_ONLN`"],
];

/**
 * Inspect a failed Bash command + its stderr. If the failure looks like
 * a Linux/macOS command-not-found mismatch we know how to fix, return a
 * one-line hint to append to the tool result. Otherwise null.
 */
export function deriveCrossOsHint(
  command: string,
  stderr: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Only fire on classic command-not-found errors. Don't second-guess
  // commands that exist but failed for other reasons.
  if (!/command not found|not found|No such file or directory/i.test(stderr)) {
    return null;
  }

  // The failed command may be the second token in a pipe / chain.
  // Inspect each segment until we find a known mismatch.
  const segments = command.split(/[;&|]+|\s&&\s|\s\|\|\s/);
  const osTable =
    platform === "darwin" ? LINUX_TO_MACOS : platform === "linux" ? MACOS_TO_LINUX : [];
  // Install hints fire on macOS only (brew is the canonical path).
  // On Linux distros, install commands diverge too much (apt vs dnf vs
  // pacman) for a single hint to be useful — the user/install.sh handles it.
  const installTable = platform === "darwin" ? MISSING_TOOL_INSTALL : [];

  for (const raw of segments) {
    const seg = raw
      .trim()
      .replace(/^sudo\s+/, "")
      .replace(/^[A-Z_]+=\S+\s+/, "");
    // OS-specific commands first (more specific equivalents).
    for (const [re, hint] of osTable) {
      if (re.test(seg)) return hint;
    }
    // Then install-suggestion fallback for missing-but-installable tools.
    for (const [re, hint] of installTable) {
      if (re.test(seg)) return hint;
    }
  }
  return null;
}

/**
 * Format a hint as an appended trailer for the tool result. Marker is
 * recognizable so reviewers can grep for cross-os assist events in the
 * audit log. Imperative phrasing — open-ended-prompt models (Qwen3-
 * Coder, etc.) routinely read mild hints as commentary instead of
 * an instruction to retry; "RETRY NOW with:" tested better.
 */
export function formatHint(hint: string): string {
  return `\n\n[cross-os-hint] RETRY NOW: ${hint}\nDo NOT report this as 'tools restricted' or 'environment limited' — re-issue the command using the equivalent above.`;
}

// ─── Layer 2: Auto-substitute table ────────────────────────────────
//
// Each entry: [matchOriginal, transform(originalCommand) → substituted]
// Only obvious equivalences — same intent, same/compatible output shape.
// Excludes:
//   - install-required (brew/apt — can't auto-run; user must approve)
//   - sudo-required (tcpdump — same)
//   - argument-incompatible (stat -c → stat -f differs)
//   - distro-specific (apt → brew package names diverge)
type AutoSubRule = {
  /** Tested against the trimmed leading-token of each pipe segment. */
  match: RegExp;
  /** Transform the matched segment into the substitute. Receives the
   *  full segment string; returns the rewritten segment. */
  rewrite: (segment: string) => string;
  /** Friendly description used in the prefix note. */
  description: string;
};

const DARWIN_AUTO_SUBS: ReadonlyArray<AutoSubRule> = [
  {
    match: /^ip\s+(addr|a|address)\b/,
    rewrite: () => "ifconfig",
    description: "ip addr → ifconfig",
  },
  {
    match: /^ip\s+(route|r)\b/,
    rewrite: () => "netstat -rn",
    description: "ip route → netstat -rn",
  },
  {
    match: /^ip\s+link\b/,
    rewrite: () => "ifconfig",
    description: "ip link → ifconfig",
  },
  {
    match: /^ss\b/,
    rewrite: () => "lsof -nP -iTCP -sTCP:LISTEN",
    description: "ss → lsof -nP -iTCP -sTCP:LISTEN",
  },
  {
    match: /^nproc\b/,
    rewrite: () => "sysctl -n hw.ncpu",
    description: "nproc → sysctl -n hw.ncpu",
  },
  {
    match: /^free\b/,
    rewrite: () => "vm_stat",
    description: "free → vm_stat",
  },
  {
    match: /^lsb_release\b/,
    rewrite: () => "sw_vers",
    description: "lsb_release → sw_vers",
  },
  {
    match: /^xdg-open\s+(.+)$/,
    rewrite: (seg) => seg.replace(/^xdg-open\s+/, "open "),
    description: "xdg-open → open",
  },
];

const LINUX_AUTO_SUBS: ReadonlyArray<AutoSubRule> = [
  {
    match: /^pbcopy\b/,
    rewrite: () => "xclip -selection clipboard",
    description: "pbcopy → xclip -selection clipboard",
  },
  {
    match: /^pbpaste\b/,
    rewrite: () => "xclip -o -selection clipboard",
    description: "pbpaste → xclip -o -selection clipboard",
  },
  {
    match: /^vm_stat\b/,
    rewrite: () => "free -h",
    description: "vm_stat → free -h",
  },
  {
    match: /^sw_vers\b/,
    rewrite: () => "lsb_release -a",
    description: "sw_vers → lsb_release -a",
  },
  {
    match: /^sysctl\s+(-n\s+)?hw\.ncpu\b/,
    rewrite: () => "nproc",
    description: "sysctl hw.ncpu → nproc",
  },
];

export interface AutoSubstitution {
  /** The rewritten command to run instead. */
  newCommand: string;
  /** Human-readable description (e.g. "ip addr → ifconfig") for the prefix note. */
  description: string;
  /** The original command, for audit trail. */
  originalCommand: string;
}

/**
 * If the failed command has a clean 1:1 substitute on the current
 * platform, return the rewritten command so the Bash tool can re-run
 * it automatically. Returns null when no auto-substitute applies —
 * caller should fall back to the hint trailer.
 *
 * Only fires for `command not found`-type errors AND when the segment
 * matches an auto-sub rule (curated list, no install-required / no
 * sudo-required / no argument-incompatible substitutions).
 */
export function deriveAutoSubstitute(
  command: string,
  stderr: string,
  platform: NodeJS.Platform = process.platform,
): AutoSubstitution | null {
  if (!/command not found|not found/i.test(stderr)) return null;

  const table =
    platform === "darwin" ? DARWIN_AUTO_SUBS : platform === "linux" ? LINUX_AUTO_SUBS : [];
  if (table.length === 0) return null;

  // Skip bare semicolons (sequencing, may include unrelated commands
  // we shouldn't rewrite). Pipes are ALLOWED — for the curated
  // substitute set, output shape is similar enough that downstream
  // pipes (e.g. `| grep default`, `| awk '{print $2}'`) keep
  // working. The big concrete win: 2026-05-08 Gemma issued
  // `ip addr show && ip route | grep default` — rejecting on the `|`
  // sent it back to "tools restricted" hallucination loop. With
  // pipes allowed: `ifconfig && netstat -rn | grep default` runs
  // clean (both output formats include the literal 'default').
  if (/;/.test(command)) return null;

  // Split on && and || (preserve the separators in the result).
  // Each segment may itself contain pipes — we only rewrite the
  // leading command of each segment, leaving pipe tail intact.
  const segments = command.split(/(\s&&\s|\s\|\|\s)/);
  if (segments.length === 0) return null;

  const stripPrefix = (s: string) => s.replace(/^sudo\s+/, "").replace(/^[A-Z_]+=\S+\s+/, "");

  let anyMatched = false;
  let firstMatchDesc = "";
  const rewritten: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    // Even-indexed elements are commands; odd-indexed are the && / || separators.
    if (i % 2 === 1) {
      rewritten.push(seg);
      continue;
    }
    const trimmed = seg.trim();
    if (trimmed.length === 0) {
      rewritten.push(seg);
      continue;
    }
    // Skip sudo-prefixed segments — semantics may differ on the substitute.
    if (trimmed.startsWith("sudo ")) {
      rewritten.push(seg);
      continue;
    }
    // Within a segment, only the part BEFORE the first pipe is the
    // command we may rewrite. The pipe tail (filters: grep, awk,
    // head, etc.) is preserved verbatim.
    const pipeIdx = trimmed.indexOf("|");
    const leadCmd = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trimEnd() : trimmed;
    const pipeTail = pipeIdx >= 0 ? trimmed.slice(pipeIdx) : "";
    const cmpSeg = stripPrefix(leadCmd);
    let segRewritten = false;
    for (const rule of table) {
      if (rule.match.test(cmpSeg)) {
        const leading = seg.match(/^\s*/)?.[0] ?? "";
        const trailing = seg.match(/\s*$/)?.[0] ?? "";
        const rewrittenLead = rule.rewrite(cmpSeg);
        const joined = pipeTail ? `${rewrittenLead} ${pipeTail}` : rewrittenLead;
        rewritten.push(leading + joined + trailing);
        if (!anyMatched) firstMatchDesc = rule.description;
        anyMatched = true;
        segRewritten = true;
        break;
      }
    }
    if (!segRewritten) rewritten.push(seg);
  }
  if (!anyMatched) return null;
  return {
    newCommand: rewritten.join(""),
    description: firstMatchDesc,
    originalCommand: command,
  };
}

/**
 * Build the prefix note that gets prepended to auto-substituted output
 * so the model and audit log both know a substitution happened.
 */
export function formatAutoSubPrefix(sub: AutoSubstitution): string {
  return `[cross-os-auto-sub] ${sub.description}\n[original] ${sub.originalCommand}\n[ran-instead] ${sub.newCommand}\n\n`;
}
