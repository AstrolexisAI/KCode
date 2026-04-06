import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./audit-engine";
import { applyFixes } from "./fixer";

describe("fixer", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "kcode-fixer-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("fixes (&buffer)[N] pointer arithmetic", async () => {
    writeFileSync(
      join(tmp, "net.cpp"),
      `void write(const void *buffer, size_t length) {
    size_t bytesTotal = 0;
    while (bytesTotal < length) {
        int s = sendto(sock, (&buffer)[bytesTotal], length-bytesTotal, 0, NULL, 0);
        bytesTotal += s;
    }
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "net.cpp"), "utf-8");
    expect(content).toContain("((const char*)buffer + bytesTotal)");
    expect(content).not.toContain("(&buffer)");
  });

  test("fixes unreachable code after return", async () => {
    writeFileSync(
      join(tmp, "peek.cpp"),
      `size_t peek() {
    int n = recv(fd, buf, sz, 0);
    if (n > 0) {
        return static_cast<size_t>(n);
        lastPacket = time(nullptr);
    }
    return 0;
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "peek.cpp"), "utf-8");
    const lines = content.split("\n");
    // lastPacket should now be BEFORE the return
    const lastPacketIdx = lines.findIndex((l) => l.includes("lastPacket"));
    const returnIdx = lines.findIndex((l) => l.includes("return static_cast"));
    expect(lastPacketIdx).toBeLessThan(returnIdx);
  });

  test("adds size validation to decode() function", async () => {
    writeFileSync(
      join(tmp, "UsbXBox.cpp"),
      `void UsbXBox::decode(const std::vector<unsigned char>& data) {
    up.setValue(data[2] & 1);
    down.setValue(data[2] >> 1 & 1);
    trigger.setValue(data[13]);
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const applied = fixes.filter((f) => f.applied);
    expect(applied.length).toBe(1);

    const content = readFileSync(join(tmp, "UsbXBox.cpp"), "utf-8");
    expect(content).toContain("if (data.size() <= 13)");
    expect(content).toContain("return;");
  });

  test("doesn't double-fix if size check already exists", async () => {
    writeFileSync(
      join(tmp, "safe.cpp"),
      `void safe::decode(const std::vector<unsigned char>& data) {
    if (data.size() <= 13) { return; }
    up.setValue(data[2] & 1);
    trigger.setValue(data[13]);
}\n`,
    );

    const result = await runAudit({
      projectRoot: tmp,
      llmCallback: async () => "VERDICT: CONFIRMED\n",
      skipVerification: true,
    });
    const fixes = applyFixes(result);
    const skipped = fixes.filter((f) => !f.applied);
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.description).toContain("already exists");
  });
});
