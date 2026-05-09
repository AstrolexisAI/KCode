// KCode - Tests for cross-os-hint
import { describe, expect, test } from "bun:test";
import {
  deriveAutoSubstitute,
  deriveCrossOsHint,
  formatAutoSubPrefix,
  formatHint,
} from "./cross-os-hint";

const NOT_FOUND = "bash: ip: command not found";

describe("deriveCrossOsHint — darwin (model issued Linux command)", () => {
  test("ip addr → ifconfig", () => {
    expect(deriveCrossOsHint("ip addr show", NOT_FOUND, "darwin")).toMatch(/ifconfig/);
  });
  test("ip route → netstat -rn", () => {
    expect(deriveCrossOsHint("ip route", NOT_FOUND, "darwin")).toMatch(/netstat -rn/);
  });
  test("ss -tlnp → lsof", () => {
    expect(deriveCrossOsHint("ss -tlnp", NOT_FOUND, "darwin")).toMatch(/lsof/);
  });
  test("nmcli → networksetup", () => {
    expect(deriveCrossOsHint("nmcli dev wifi list", NOT_FOUND, "darwin")).toMatch(/networksetup/);
  });
  test("apt-get → brew", () => {
    expect(deriveCrossOsHint("apt-get install jq", NOT_FOUND, "darwin")).toMatch(/brew/);
  });
  test("systemctl → launchctl", () => {
    expect(deriveCrossOsHint("systemctl status nginx", NOT_FOUND, "darwin")).toMatch(/launchctl/);
  });
  test("xdg-open → open", () => {
    expect(deriveCrossOsHint("xdg-open foo.html", NOT_FOUND, "darwin")).toMatch(/`open`/);
  });
  test("xclip → pbcopy/pbpaste", () => {
    expect(deriveCrossOsHint("xclip -selection clipboard", NOT_FOUND, "darwin")).toMatch(/pbcopy/);
  });
  test("nproc → sysctl hw.ncpu", () => {
    expect(deriveCrossOsHint("nproc", NOT_FOUND, "darwin")).toMatch(/hw\.ncpu/);
  });
  test("free → vm_stat", () => {
    expect(deriveCrossOsHint("free -h", NOT_FOUND, "darwin")).toMatch(/vm_stat/);
  });
  test("piped/chained command — picks up the failing segment", () => {
    expect(
      deriveCrossOsHint("cat /etc/foo | nmcli dev", "bash: nmcli: command not found", "darwin"),
    ).toMatch(/networksetup/);
  });
  test("sudo prefix is stripped", () => {
    expect(deriveCrossOsHint("sudo systemctl restart x", NOT_FOUND, "darwin")).toMatch(/launchctl/);
  });
});

describe("deriveCrossOsHint — linux (model issued macOS command)", () => {
  test("networksetup → nmcli/iw/ip", () => {
    expect(
      deriveCrossOsHint("networksetup -getairportnetwork en0", "command not found", "linux"),
    ).toMatch(/nmcli/);
  });
  test("pbcopy → xclip", () => {
    expect(deriveCrossOsHint("pbcopy", "command not found", "linux")).toMatch(/xclip/);
  });
  test("launchctl → systemctl", () => {
    expect(deriveCrossOsHint("launchctl list", "command not found", "linux")).toMatch(/systemctl/);
  });
  test("sw_vers → lsb_release", () => {
    expect(deriveCrossOsHint("sw_vers -productVersion", "command not found", "linux")).toMatch(
      /lsb_release/,
    );
  });
  test("vm_stat → free", () => {
    expect(deriveCrossOsHint("vm_stat", "command not found", "linux")).toMatch(/free -h/);
  });
});

describe("deriveCrossOsHint — missing-tool install suggestions (darwin)", () => {
  test("nmap → brew install nmap", () => {
    expect(deriveCrossOsHint("nmap -sn 192.168.1.0/24", NOT_FOUND, "darwin")).toMatch(
      /brew install nmap/,
    );
  });
  test("arp-scan → brew install arp-scan", () => {
    expect(deriveCrossOsHint("arp-scan --localnet", NOT_FOUND, "darwin")).toMatch(
      /brew install arp-scan/,
    );
  });
  test("htop → brew install htop", () => {
    expect(deriveCrossOsHint("htop", NOT_FOUND, "darwin")).toMatch(/brew install htop/);
  });
  test("jq → brew install jq", () => {
    expect(deriveCrossOsHint("jq .", NOT_FOUND, "darwin")).toMatch(/brew install jq/);
  });
  test("install hints do NOT fire on linux", () => {
    expect(deriveCrossOsHint("nmap localhost", NOT_FOUND, "linux")).toBeNull();
  });
});

describe("deriveCrossOsHint — null cases", () => {
  test("returns null when stderr has no command-not-found signal", () => {
    expect(deriveCrossOsHint("ip addr show", "permission denied", "darwin")).toBeNull();
  });
  test("returns null when the failing command is unknown", () => {
    expect(deriveCrossOsHint("custom-internal-tool --foo", NOT_FOUND, "darwin")).toBeNull();
  });
  test("returns null on platforms without a mapping (e.g. windows)", () => {
    expect(deriveCrossOsHint("ip addr", NOT_FOUND, "win32")).toBeNull();
  });
  test("does not fire on `open` for actual file paths (avoids false positive)", () => {
    // `open .` and `open /path` are valid macOS commands, but our regex
    // is darwin→linux only, so these don't match the linux table at all.
    expect(deriveCrossOsHint("open .", NOT_FOUND, "darwin")).toBeNull();
    expect(deriveCrossOsHint("open /tmp/foo", NOT_FOUND, "darwin")).toBeNull();
  });
});

describe("deriveAutoSubstitute — darwin (clean 1:1)", () => {
  test("ip addr → ifconfig", () => {
    const r = deriveAutoSubstitute("ip addr show", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig");
    expect(r?.description).toMatch(/ip addr → ifconfig/);
    expect(r?.originalCommand).toBe("ip addr show");
  });
  test("ip route → netstat -rn", () => {
    expect(deriveAutoSubstitute("ip route", NOT_FOUND, "darwin")?.newCommand).toBe("netstat -rn");
  });
  test("ss → lsof", () => {
    expect(deriveAutoSubstitute("ss -tlnp", NOT_FOUND, "darwin")?.newCommand).toMatch(/lsof/);
  });
  test("nproc → sysctl -n hw.ncpu", () => {
    expect(deriveAutoSubstitute("nproc", NOT_FOUND, "darwin")?.newCommand).toBe(
      "sysctl -n hw.ncpu",
    );
  });
  test("xdg-open <url> preserves the argument", () => {
    expect(
      deriveAutoSubstitute("xdg-open https://example.com", NOT_FOUND, "darwin")?.newCommand,
    ).toBe("open https://example.com");
  });
});

describe("deriveAutoSubstitute — null cases", () => {
  test("returns null when stderr is not command-not-found", () => {
    expect(deriveAutoSubstitute("ip addr", "permission denied", "darwin")).toBeNull();
  });
  test("returns null for sudo-prefixed commands (could differ semantically)", () => {
    expect(deriveAutoSubstitute("sudo ip addr", NOT_FOUND, "darwin")).toBeNull();
  });
  test("returns null for semicolon-chained commands", () => {
    expect(deriveAutoSubstitute("ifconfig; ip addr", NOT_FOUND, "darwin")).toBeNull();
  });
  test("returns null for install-required tools (model must run brew install)", () => {
    expect(deriveAutoSubstitute("nmap localhost", NOT_FOUND, "darwin")).toBeNull();
  });
  test("returns null for unknown commands", () => {
    expect(deriveAutoSubstitute("zfoobar --baz", NOT_FOUND, "darwin")).toBeNull();
  });
});

describe("deriveAutoSubstitute — chain rewriting (the Gemma 'analiza la red' fail)", () => {
  test("rewrites BOTH segments in 'ip addr && ip route'", () => {
    const r = deriveAutoSubstitute("ip addr && ip route", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig && netstat -rn");
  });
  test("rewrites only the matching segment in mixed chain", () => {
    const r = deriveAutoSubstitute("ifconfig && ip route", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig && netstat -rn");
  });
  test("rewrites all three matching segments in a long chain", () => {
    const r = deriveAutoSubstitute("ip addr && ip route && ss -tln", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig && netstat -rn && lsof -nP -iTCP -sTCP:LISTEN");
  });
  test("returns null when no chain segment matches a rule", () => {
    expect(deriveAutoSubstitute("ifconfig && netstat -rn", NOT_FOUND, "darwin")).toBeNull();
  });
  test("preserves pipe tail when rewriting (the real Gemma case)", () => {
    const r = deriveAutoSubstitute("ip addr show && ip route | grep default", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig && netstat -rn | grep default");
  });
  test("rewrites command with pipe tail (e.g. `ip addr | head -5`)", () => {
    const r = deriveAutoSubstitute("ip addr | head -5", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("ifconfig | head -5");
  });
  test("preserves multi-stage pipe (`ip route | awk '{print $1}' | head`)", () => {
    const r = deriveAutoSubstitute("ip route | awk '{print $1}' | head", NOT_FOUND, "darwin");
    expect(r?.newCommand).toBe("netstat -rn | awk '{print $1}' | head");
  });
});

describe("deriveAutoSubstitute — linux", () => {
  test("pbcopy → xclip", () => {
    expect(deriveAutoSubstitute("pbcopy", "command not found", "linux")?.newCommand).toMatch(
      /xclip/,
    );
  });
  test("vm_stat → free -h", () => {
    expect(deriveAutoSubstitute("vm_stat", "command not found", "linux")?.newCommand).toBe(
      "free -h",
    );
  });
});

describe("formatAutoSubPrefix", () => {
  test("emits a recognizable audit-log marker with original + substitute", () => {
    const out = formatAutoSubPrefix({
      newCommand: "ifconfig",
      description: "ip addr → ifconfig",
      originalCommand: "ip addr show",
    });
    expect(out).toMatch(/\[cross-os-auto-sub\] ip addr → ifconfig/);
    expect(out).toMatch(/\[original\] ip addr show/);
    expect(out).toMatch(/\[ran-instead\] ifconfig/);
  });
});

describe("formatHint", () => {
  test("prepends a recognizable marker for audit-log greps", () => {
    expect(formatHint("Use foo")).toMatch(/\[cross-os-hint\] RETRY NOW: Use foo/);
  });
  test("includes anti-give-up directive", () => {
    expect(formatHint("X")).toMatch(/Do NOT report this as 'tools restricted'/);
  });
});
