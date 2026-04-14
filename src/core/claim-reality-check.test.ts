// Tests for phase 15 — claim-vs-reality detection.

import { describe, expect, test } from "bun:test";
import {
  buildClaimMismatchReminder,
  buildContentMismatchReminder,
  buildRealityCheckReminder,
  checkClaimReality,
  checkContentMismatch,
  collectTurnToolActivity,
  countSuccessfulMutations,
  extractClaims,
  extractProseUrls,
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
      isClaimMutationMismatch: false,
      claims: ["Updated version to v2.3", "Changed 2025 to 2026"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toContain("[REALITY CHECK]");
  });

  test("lists the specific claims verbatim", () => {
    const reminder = buildRealityCheckReminder({
      isHallucinatedCompletion: true,
      isClaimMutationMismatch: false,
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
      isClaimMutationMismatch: false,
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
      isClaimMutationMismatch: false,
      claims: ["x"],
      successfulMutations: 0,
      mutatingToolNames: [],
    });
    expect(reminder).toMatch(/a\)\s+actually make/i);
    expect(reminder).toMatch(/b\)\s+retract/i);
  });
});

// ─── Phase 18: claim/mutation mismatch ──────────────────────────

/**
 * Build a messages array with N successful Edit tool results. Each Edit
 * is represented as an assistant tool_use + matching user tool_result
 * containing a success marker ("Edited" / "replacements") so that
 * countSuccessfulMutations counts them as real mutations.
 */
function buildMessagesWithEdits(editCount: number, userText = "refactor"): Message[] {
  const messages: Message[] = [{ role: "user", content: userText }];
  for (let i = 0; i < editCount; i++) {
    const id = `edit_${i}`;
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name: "Edit",
          input: { file_path: `/tmp/f.html`, old_string: "a", new_string: "b" },
        } as unknown as never,
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: false,
          content: `Edited /tmp/f.html (1 replacement, +1 lines)`,
        } as unknown as never,
      ],
    });
  }
  return messages;
}

describe("phase 18: claim/mutation mismatch", () => {
  test("fires when many claims but only 2 mutations", () => {
    const messages = buildMessagesWithEdits(2);
    // Mirror the NASA Explorer session: lots of padding around 2 real Edits
    const text = `
      Refactor complete.
      Updated the star-bg animation to be smoother.
      Updated the nav-link active state styling.
      Updated the section comments throughout.
      Changed the counter animation to be performant.
      Changed the modal handling to use a single function.
      Added a new keyboard support layer.
      Added the section-header utility class.
      Fixed the responsive layout edge case.
    `;
    const v = checkClaimReality(text, messages);
    expect(v.isHallucinatedCompletion).toBe(false);
    expect(v.isClaimMutationMismatch).toBe(true);
    expect(v.successfulMutations).toBe(2);
    expect(v.claims.length).toBeGreaterThanOrEqual(6);
  });

  test("does NOT fire when claims match mutations 1:1", () => {
    const messages = buildMessagesWithEdits(5);
    const text = `
      Updated the version header.
      Changed the hardcoded date to 2026.
      Replaced the red-400 class throughout.
      Fixed the typo in the comment block.
      Added the new import statement.
    `;
    const v = checkClaimReality(text, messages);
    expect(v.isClaimMutationMismatch).toBe(false);
  });

  test("does NOT fire when below claim threshold (few claims, 1 edit)", () => {
    const messages = buildMessagesWithEdits(1);
    const text = `Updated the config value. Changed the port number.`;
    const v = checkClaimReality(text, messages);
    expect(v.isClaimMutationMismatch).toBe(false);
  });

  test("does NOT fire when isHallucinatedCompletion already fired", () => {
    // 0 mutations, 5 claims — hallucinatedCompletion takes precedence
    const messages: Message[] = [{ role: "user", content: "refactor" }];
    const text = `
      Updated the config file.
      Changed the port number.
      Replaced the URL constant.
      Fixed the startup typo.
      Added a new import.
    `;
    const v = checkClaimReality(text, messages);
    expect(v.isHallucinatedCompletion).toBe(true);
    expect(v.isClaimMutationMismatch).toBe(false);
  });

  test("mismatch reminder names the ratio and lists claims", () => {
    const reminder = buildClaimMismatchReminder({
      isHallucinatedCompletion: false,
      isClaimMutationMismatch: true,
      claims: [
        "Updated star-bg",
        "Added nav-link.active",
        "Changed counter animation",
        "Replaced keyboard handler",
        "Fixed modal close",
        "Added section-header utility",
      ],
      successfulMutations: 2,
      mutatingToolNames: ["Edit", "Edit"],
    });
    expect(reminder).toContain("CLAIM/MUTATION MISMATCH");
    expect(reminder).toContain("6 distinct change claims");
    expect(reminder).toContain("2 mutation tool call");
    expect(reminder).toMatch(/padding/i);
    expect(reminder).toMatch(/a\)/);
    expect(reminder).toMatch(/b\)/);
    expect(reminder).toContain("Updated star-bg");
  });
});

// ─── Phase 20: content-level mismatch ────────────────────────────

describe("extractProseUrls", () => {
  test("extracts URLs from markdown code blocks and prose", () => {
    const text = `
      I updated the array:
      url: 'https://picsum.photos/id/1015/600/380'
      url: 'https://picsum.photos/id/133/600/380'

      More info at https://example.com/docs.
    `;
    const urls = extractProseUrls(text);
    expect(urls).toContain("https://picsum.photos/id/1015/600/380");
    expect(urls).toContain("https://picsum.photos/id/133/600/380");
    expect(urls).toContain("https://example.com/docs");
  });

  test("strips trailing punctuation", () => {
    const text = `See https://example.com/foo, and then https://bar.com/baz.`;
    const urls = extractProseUrls(text);
    expect(urls).toContain("https://example.com/foo");
    expect(urls).toContain("https://bar.com/baz");
  });

  test("deduplicates", () => {
    const text = `https://a.com/x and https://a.com/x again`;
    const urls = extractProseUrls(text);
    expect(urls.length).toBe(1);
  });

  test("returns empty on text with no URLs", () => {
    expect(extractProseUrls("no urls here").length).toBe(0);
  });
});

describe("collectTurnToolActivity", () => {
  test("includes tool_use inputs and tool_result content", () => {
    const messages: Message[] = [
      { role: "user", content: "do work" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Edit",
            input: {
              file_path: "/tmp/f.html",
              old_string: "old",
              new_string: "https://real.example.com/a.jpg",
            },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: false,
            content: "Edited f.html (1 replacement, +1 lines)",
          } as unknown as never,
        ],
      },
    ];
    const blob = collectTurnToolActivity(messages);
    expect(blob).toContain("https://real.example.com/a.jpg");
    expect(blob).toContain("Edited f.html");
  });
});

describe("phase 20: checkContentMismatch", () => {
  function buildMessagesWithEditedUrl(urlInEdit: string): Message[] {
    return [
      { role: "user", content: "fix the images" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "e1",
            name: "Edit",
            input: {
              file_path: "/tmp/orbital.html",
              old_string: "url: 'https://old.com/a.jpg'",
              new_string: `url: '${urlInEdit}'`,
            },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "e1",
            is_error: false,
            content: `Edited orbital.html (1 replacement, +0 lines)`,
          } as unknown as never,
        ],
      },
    ];
  }

  test("fires on Orbital/Mars session: prose picsum URLs, Edit had photojournal URLs", () => {
    const messages = buildMessagesWithEditedUrl(
      "https://photojournal.jpl.nasa.gov/jpeg/PIA26090.jpg",
    );
    // The model's final text claims it used picsum URLs — which were
    // never in any tool call
    const text = `
      Cambios realizados:
      url: 'https://picsum.photos/id/1015/600/380'
      url: 'https://picsum.photos/id/133/600/380'
      url: 'https://picsum.photos/id/160/600/380'
      url: 'https://picsum.photos/id/201/600/380'
    `;
    const v = checkContentMismatch(text, messages);
    expect(v.isContentMismatch).toBe(true);
    expect(v.missingLiterals.length).toBeGreaterThanOrEqual(2);
    expect(
      v.missingLiterals.some((u) => u.includes("picsum.photos/id/1015")),
    ).toBe(true);
  });

  test("does NOT fire when prose URLs match what was in the Edit", () => {
    const messages = buildMessagesWithEditedUrl("https://real.example.com/a.jpg");
    const text = `
      I updated the image:
      Now using https://real.example.com/a.jpg
      and https://real.example.com/b.jpg
    `;
    const v = checkContentMismatch(text, messages);
    // Only 1 URL is missing (b.jpg), which is below the 2-missing threshold
    expect(v.isContentMismatch).toBe(false);
  });

  test("does NOT fire with fewer than 2 URLs in prose", () => {
    const messages = buildMessagesWithEditedUrl("https://real.example.com/a.jpg");
    const text = `See https://some-other.com/fake for more info.`;
    const v = checkContentMismatch(text, messages);
    expect(v.isContentMismatch).toBe(false);
  });

  test("does NOT fire when all prose URLs are found in failed tool inputs", () => {
    // Even if the Edit failed, the URL was legitimately attempted
    const messages: Message[] = [
      { role: "user", content: "fix" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "e1",
            name: "Edit",
            input: {
              file_path: "/tmp/f.html",
              old_string: "nomatch",
              new_string:
                "url: 'https://attempted1.com/a.jpg' and 'https://attempted2.com/b.jpg'",
            },
          } as unknown as never,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "e1",
            is_error: true,
            content: "Edit failed: old_string not found",
          } as unknown as never,
        ],
      },
    ];
    const text = `
      I attempted to set https://attempted1.com/a.jpg and
      https://attempted2.com/b.jpg but the edit failed.
    `;
    const v = checkContentMismatch(text, messages);
    expect(v.isContentMismatch).toBe(false);
  });

  test("reminder names missing URLs and offers resolutions", () => {
    const reminder = buildContentMismatchReminder({
      isContentMismatch: true,
      missingLiterals: [
        "https://picsum.photos/id/1015/600/380",
        "https://picsum.photos/id/133/600/380",
        "https://picsum.photos/id/160/600/380",
      ],
      foundLiterals: [],
    });
    expect(reminder).toContain("CONTENT MISMATCH");
    expect(reminder).toContain("picsum.photos/id/1015");
    expect(reminder).toContain("picsum.photos/id/133");
    expect(reminder).toMatch(/a\)/);
    expect(reminder).toMatch(/b\)/);
    expect(reminder).toMatch(/Retract/i);
  });
});
