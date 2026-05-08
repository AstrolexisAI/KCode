// KCode - Tests for cross-os-hint
import { describe, expect, test } from "bun:test";
import { deriveCrossOsHint, formatHint } from "./cross-os-hint";

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

describe("formatHint", () => {
  test("prepends a recognizable marker for audit-log greps", () => {
    expect(formatHint("Use foo")).toMatch(/\[cross-os-hint\] RETRY NOW: Use foo/);
  });
  test("includes anti-give-up directive", () => {
    expect(formatHint("X")).toMatch(/Do NOT report this as 'tools restricted'/);
  });
});
