// KCode - Cross-OS command hint
//
// When a Bash command fails with `command not found` because the user
// is on macOS but the model issued a Linux-only command (or vice-versa),
// append a one-line hint pointing at the equivalent. This is a reactive
// safety net — system-prompt guidance covers the same ground proactively
// but coder-tuned models routinely ignore it (verified 2026-05-08 with
// Qwen3-Coder-30B running `ip addr show` on macOS three times in a row
// even with the explicit Linux↔macOS table in the prompt).
//
// Surgical scope: we only fire on commands we *know* have a clean
// equivalent. We never rewrite the actual command — only the error
// message the model sees, so the next turn's tool-call is informed
// without us silently changing intent.

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
