// KCode - RemoteAuthorize Tool
//
// Lets the model drive the SSH bootstrap from a natural-language prompt.
// Two-step flow because the user has to copy/paste a snippet onto
// another machine — we can't do that in one shot:
//
//   step="issue"  → return the snippet for the model to show.
//                   Caller (model) must then ask the user to run it.
//   step="verify" → test SSH and persist to ~/.kcode/remotes.json.
//                   If green, the remote is registered.
//
// The model is instructed in the description to: (a) call with "issue"
// first, (b) display the snippet to the user verbatim, (c) wait for
// the user's confirmation in their reply, (d) call again with "verify"
// to finalize.

import {
  buildAuthorizeSnippet,
  ensurePubkey,
  fetchHostFingerprint,
  findRemote,
  testConnectivity,
  upsertRemote,
} from "../remote/remote-authorize";
import type { ToolDefinition, ToolResult } from "../core/types";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?::\d{1,5})?$|^[A-Za-z0-9._-]+(?::\d{1,5})?$/;

export const remoteAuthorizeDefinition: ToolDefinition = {
  name: "RemoteAuthorize",
  description:
    "Bootstrap SSH access to a host on the LAN so KCode can later operate it. " +
    "USE THIS when the user asks to authorize / control / take over a remote machine, " +
    "laptop, server, or LAN host. Two-step flow:\n" +
    "  1. Call with step='issue' and {name, target} → returns the one-liner snippet " +
    "the user must run on the target. Show that snippet to the user verbatim and ask " +
    "them to run it on the target machine, then come back.\n" +
    "  2. After the user confirms, call again with step='verify' and the same {name, " +
    "target} → tests SSH and registers the remote in ~/.kcode/remotes.json.\n" +
    "Names: 1-32 chars [A-Za-z0-9_-] (e.g. 'laptop', 'mac-office'). " +
    "Target: user@host or user@host:port (e.g. 'curly@192.168.1.58'). " +
    "Pubkeys are public — the snippet is safe to share. " +
    "If verify fails, surface the error and offer to retry; do NOT register a " +
    "remote that didn't connect.",
  input_schema: {
    type: "object" as const,
    properties: {
      step: {
        type: "string",
        enum: ["issue", "verify"],
        description: "'issue' to render the snippet, 'verify' to test+register after the user runs it",
      },
      name: {
        type: "string",
        description: "Friendly name for the remote, 1-32 chars [A-Za-z0-9_-]",
      },
      target: {
        type: "string",
        description: "SSH target: user@host or user@host:port",
      },
    },
    required: ["step", "name", "target"],
  },
};

export async function executeRemoteAuthorize(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const step = String(input.step ?? "");
  const name = String(input.name ?? "");
  const target = String(input.target ?? "");

  if (!NAME_RE.test(name)) {
    return {
      tool_use_id: "",
      content: `Error: name must match ${NAME_RE.source} (got: ${JSON.stringify(name)})`,
      is_error: true,
    };
  }
  if (!TARGET_RE.test(target)) {
    return {
      tool_use_id: "",
      content: `Error: target must look like 'user@host' or 'user@host:port' (got: ${JSON.stringify(target)})`,
      is_error: true,
    };
  }

  if (step === "issue") {
    if (findRemote(name)) {
      return {
        tool_use_id: "",
        content: `Remote '${name}' already exists. Either pick another name, or remove the existing one first (kcode remote rm ${name}).`,
        is_error: true,
      };
    }
    let pubkey: { path: string; content: string };
    try {
      pubkey = ensurePubkey();
    } catch (err) {
      return {
        tool_use_id: "",
        content: `Failed to find or generate an SSH pubkey: ${err instanceof Error ? err.message : err}`,
        is_error: true,
      };
    }
    let snippet: string;
    try {
      snippet = buildAuthorizeSnippet(pubkey.content);
    } catch (err) {
      return {
        tool_use_id: "",
        content: `Failed to build snippet: ${err instanceof Error ? err.message : err}`,
        is_error: true,
      };
    }
    const message = [
      `Pubkey: ${pubkey.path}`,
      "",
      `On the target (${target}), the user must run this snippet to authorize KCode:`,
      "",
      snippet,
      "",
      "Once they confirm they ran it, call this tool again with step='verify' " +
        "and the same name/target to test and register.",
      "(Pubkey is public — the snippet is safe to share.)",
    ].join("\n");
    return { tool_use_id: "", content: message };
  }

  if (step === "verify") {
    if (!testConnectivity(target)) {
      return {
        tool_use_id: "",
        content:
          `SSH to ${target} still failed. Common causes:\n` +
          "  - The snippet was not run on the target (or run on the wrong machine)\n" +
          "  - Remote Login (sshd) is disabled on the target\n" +
          "  - A firewall blocks port 22\n" +
          "  - The user/host string is wrong\n\n" +
          "Ask the user to verify they ran the snippet on the correct machine, " +
          "then call verify again. Do NOT register the remote until SSH works.",
        is_error: true,
      };
    }
    let pubkey: { path: string; content: string };
    try {
      pubkey = ensurePubkey();
    } catch (err) {
      return {
        tool_use_id: "",
        content: `SSH worked, but failed to read pubkey for the registry entry: ${err instanceof Error ? err.message : err}`,
        is_error: true,
      };
    }
    const fingerprint = fetchHostFingerprint(target);
    const now = new Date().toISOString();
    upsertRemote({
      name,
      target,
      hostFingerprint: fingerprint,
      addedAt: now,
      lastSeen: now,
      authorizedWithPubkey: pubkey.content,
    });
    const lines = [
      `Authorized and registered '${name}' → ${target}.`,
      fingerprint ? `  fingerprint: ${fingerprint}` : "",
      "Future tools (Bash/Read over SSH) can now use this remote by name.",
    ].filter(Boolean);
    return { tool_use_id: "", content: lines.join("\n") };
  }

  return {
    tool_use_id: "",
    content: `Error: unknown step ${JSON.stringify(step)} (must be 'issue' or 'verify')`,
    is_error: true,
  };
}
