// Tests for phase 15 — claim-vs-reality detection.

import { describe, expect, test } from "bun:test";
import {
  buildRealityCheckReminder,
  checkClaimReality,
  countSuccessfulMutations,
  extractClaims,
} from "./claim-reality-check";
import type { Message } from "./types";

describe("extractClaims", () => {
  test("returns empty when text has no claims", () => {
    const r = extractClaims("Just reading the file to understand the layout.");
    expect(r.claims.length).toBe(0);
    expect(r.hasCompletionMarker).toBe(false);
  });

  test("detects 'Updated X' claims", () => {
    const r = extractClaims("Updated the version header to reflect 2026.");
    expect(r.claims.length).toBeGreaterThanOrEqual(1);
    expect(r.claims[0]!.toLowerCase()).toContain("updated");
  });

  test("detects 'Changed X' claims", () => {
    const r = extractClaims("Changed all hardcoded dates from 2025 to 2026.");
    expect(r.claims.length).toBeGreaterThanOrEqual(1);
  });

  test("detects 'Replaced X' claims", () => {
    const r = extractClaims("Replaced remaining red-400 classes with border-[#FC3D21]");
    expect(r.claims.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Spanish claims", () => {
    const r = extractClaims("Actualicé el encabezado. Cambié las fechas a 2026.");
    expect(r.claims.length).toBeGreaterThanOrEqual(2);
  });

  test("detects completion markers", () => {
    expect(extractClaims("Task completed.").hasCompletionMarker).toBe(true);
    expect(extractClaims("Successfully updated the file.").hasCompletionMarker).toBe(true);
    expect(extractClaims("Updated successfully.").hasCompletionMarker).toBe(true);
    expect(extractClaims("Done!").hasCompletionMarker).toBe(true);
    expect(extractClaims("Listo para usar.").hasCompletionMarker).toBe(true);
  });

  test("detects the exact failing-session summary", () => {
    const summary = `
      Refactored successfully (minimal changes only).
      Changes Applied (v2.1 → v2.3)
      - Updated version header and all inline comments to reflect 2026
      - Changed all hardcoded dates from 2025 → 2026 (APOD, Mars photos, launches)
      - Replaced remaining red-400 classes with border-[#FC3D21]
    `;
    const r = extractClaims(summary);
    expect(r.claims.length).toBeGreaterThanOrEqual(3);
    expect(r.hasCompletionMarker).toBe(true);
  });
});

describe("countSuccessfulMutations", () => {
  test("returns 0 for an empty turn", () => {
    const r = countSuccessfulMutations([
      { role: "user", content: "make the change" },
    ] as Message[]);
    expect(r.successful).toBe(0);
  });

  test("counts a successful Write", () => {
    const messages: Message[] = [
      { role: "user", content: "create x.html" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x.html", content: "a" } },
        ],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Created /x.html (1 lines)", is_error: false },
        ],
      } as unknown as Message,
    ];
    const r = countSuccessfulMutations(messages);
    expect(r.successful).toBe(1);
    expect(r.names).toContain("Write");
  });

  test("ignores failed tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "edit the file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } },
        ],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Error: old_string not found", is_error: true },
        ],
      } as unknown as Message,
    ];
    const r = countSuccessfulMutations(messages);
    expect(r.successful).toBe(0);
  });

  test("ignores read-only tools even on success", () => {
    const messages: Message[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents", is_error: false },
        ],
      } as unknown as Message,
    ];
    const r = countSuccessfulMutations(messages);
    expect(r.successful).toBe(0);
  });

  test("counts only the current turn (after the last user text)", () => {
    const messages: Message[] = [
      { role: "user", content: "first task" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/a" } },
        ],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Created /a", is_error: false },
        ],
      } as unknown as Message,
      // NEW user turn starts here — previous mutations should not count
      { role: "user", content: "second task — just read" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } }],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "contents", is_error: false },
        ],
      } as unknown as Message,
    ];
    const r = countSuccessfulMutations(messages);
    expect(r.successful).toBe(0);
  });
});

describe("checkClaimReality", () => {
  test("not hallucinated when no claims", () => {
    const v = checkClaimReality("Still working on it, will continue next turn.", []);
    expect(v.isHallucinatedCompletion).toBe(false);
  });

  test("not hallucinated when claims are backed by real mutations", () => {
    const messages: Message[] = [
      { role: "user", content: "edit the file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x" } },
        ],
      } as unknown as Message,
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Created /x (1 lines)", is_error: false },
        ],
      } as unknown as Message,
    ];
    const v = checkClaimReality("Updated the file. Successfully changed version to 2026.", messages);
    expect(v.isHallucinatedCompletion).toBe(false);
    expect(v.successfulMutations).toBe(1);
  });

  test("fires on the exact failing-session pattern", () => {
    const summary = `
      Refactored successfully.
      - Updated version header to 2026
      - Changed dates from 2025 to 2026
      - Replaced red-400 with [#FC3D21]
    `;
    // Turn with only failed Edits and no successful mutations
    const messages: Message[] = [
      { role: "user", content: "refactor the nasa file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/nasa" } },
        ],
      } as unknown as Message,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "Error: old_string not found",
            is_error: true,
          },
        ],
      } as unknown as Message,
    ];
    const v = checkClaimReality(summary, messages);
    expect(v.isHallucinatedCompletion).toBe(true);
    expect(v.claims.length).toBeGreaterThanOrEqual(3);
    expect(v.successfulMutations).toBe(0);
  });

  test("does NOT fire on a single soft claim without completion marker", () => {
    const v = checkClaimReality(
      "Added a note about the layout — will continue next turn.",
      [],
    );
    expect(v.isHallucinatedCompletion).toBe(false);
  });

  test("fires on a single claim with completion marker", () => {
    const v = checkClaimReality("Updated the version. Task completed.", []);
    expect(v.isHallucinatedCompletion).toBe(true);
  });
});

describe("buildRealityCheckReminder", () => {
  test("contains [REALITY CHECK] header", () => {
    const reminder = buildRealityCheckReminder({
      isHallucinatedCompletion: true,
      claims: ["Updated version to v2.3", "Changed 2025 to 2026"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toContain("[REALITY CHECK]");
  });

  test("lists the specific claims verbatim", () => {
    const reminder = buildRealityCheckReminder({
      isHallucinatedCompletion: true,
      claims: ["Updated version to v2.3", "Changed 2025 to 2026"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toContain("Updated version to v2.3");
    expect(reminder).toContain("Changed 2025 to 2026");
  });

  test("explains common causes (Edit fail, GrepReplace no match, sed no-op)", () => {
    const reminder = buildRealityCheckReminder({
      isHallucinatedCompletion: true,
      claims: ["x"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toMatch(/old_string not found/i);
    expect(reminder).toMatch(/No matching files found/);
    expect(reminder).toMatch(/sed.*exit 0.*zero matches/i);
  });

  test("offers two concrete resolutions (a/b)", () => {
    const reminder = buildRealityCheckReminder({
      isHallucinatedCompletion: true,
      claims: ["x"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toMatch(/a\)\s+actually make/i);
    expect(reminder).toMatch(/b\)\s+retract/i);
  });
});
