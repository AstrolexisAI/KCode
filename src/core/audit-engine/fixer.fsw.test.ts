// Tests for v2.10.315 flight-software bespoke fixers.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAudit } from "./audit-engine";
import { applyFixes } from "./fixer";

let TMP: string;
beforeEach(() => {
  TMP = `/tmp/kcode-fsw-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

async function scanAndFix(file: string, content: string) {
  const full = join(TMP, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  const result = await runAudit({
    projectRoot: TMP,
    llmCallback: async () => "VERDICT: confirmed\nREASONING: test\n",
    skipVerification: true,
  });
  applyFixes(result);
  return readFileSync(full, "utf-8");
}

describe("fsw-005 bespoke fixer (Fw::Buffer.getData null-check)", () => {
  it("inserts FW_ASSERT before getData() use", async () => {
    const out = await scanAndFix(
      "Hub.cpp",
      `void Hub::handler(Fw::Buffer fwBuffer) {
    U8* rawData = fwBuffer.getData() + 12;
    process(rawData);
}
`,
    );
    expect(out).toContain("FW_ASSERT(fwBuffer.getData() != nullptr)");
    expect(out).toContain("audit-fix:fsw-005");
    // The original code is preserved
    expect(out).toContain("U8* rawData = fwBuffer.getData() + 12;");
  });

  it("is idempotent (second run is a no-op)", async () => {
    const original = `void Hub::handler(Fw::Buffer fwBuffer) {
    FW_ASSERT(fwBuffer.getData() != nullptr);  // audit-fix:fsw-005
    U8* rawData = fwBuffer.getData() + 12;
}
`;
    const out = await scanAndFix("Hub.cpp", original);
    // Count occurrences of FW_ASSERT — should still be 1, not 2
    const matches = (out.match(/FW_ASSERT\(fwBuffer\.getData\(\) != nullptr\)/g) ?? []).length;
    expect(matches).toBe(1);
  });
});

describe("fsw-010 bespoke fixer (cmd-arg before validate)", () => {
  it("inserts length-check + VALIDATION_ERROR at handler start", async () => {
    const out = await scanAndFix(
      "FileMgr.cpp",
      `void FileManager::CreateDirectory_cmdHandler(const FwOpcodeType opCode,
                                              const U32 cmdSeq,
                                              const Fw::CmdStringArg& dirName) {
    Os::FileSystem::createDirectory(dirName.toChar(), true);
    this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::OK);
}
`,
    );
    expect(out).toContain("if (dirName.length() == 0");
    expect(out).toContain("VALIDATION_ERROR");
    expect(out).toContain("audit-fix:fsw-010");
    // Real call still present after the guard
    expect(out).toContain("Os::FileSystem::createDirectory(dirName.toChar(), true);");
    // Order: guard appears BEFORE the createDirectory call
    const guardLine = out.indexOf("VALIDATION_ERROR");
    const callLine = out.indexOf("createDirectory");
    expect(guardLine).toBeLessThan(callLine);
  });

  it("is idempotent — does not double-insert if guard already present", async () => {
    const original = `void Mgr::REMOVE_cmdHandler(const FwOpcodeType opCode, const U32 cmdSeq, const Fw::CmdStringArg& fileName) {
    // audit-fix:fsw-010 — reject malformed ground-command argument before any side effect.
    if (fileName.length() == 0 || fileName.length() >= Fw::CmdStringArg::SERIALIZED_SIZE) {
        this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::VALIDATION_ERROR);
        return;
    }
    Os::FileSystem::removeFile(fileName.toChar());
}
`;
    const out = await scanAndFix("Mgr.cpp", original);
    const matches = (out.match(/VALIDATION_ERROR/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it("picks the correct StringArg parameter when multiple args present", async () => {
    const out = await scanAndFix(
      "Seq.cpp",
      `void FpySequencer::VALIDATE_cmdHandler(FwOpcodeType opCode,
                                       U32 cmdSeq,
                                       const Fw::CmdStringArg& fileName) {
    this->load(fileName);
}
`,
    );
    expect(out).toContain("if (fileName.length() == 0");
    expect(out).not.toContain("if (cmdSeq.length()");
    expect(out).not.toContain("if (opCode.length()");
  });
});
