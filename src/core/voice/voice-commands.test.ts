// KCode - Voice Commands Tests

import { describe, expect, test } from "bun:test";
import { parseVoiceCommand } from "./voice-commands";

describe("parseVoiceCommand", () => {
  // ─── Action: submit ─────────────────────────────────────────

  test("'enviar' maps to submit action", () => {
    const result = parseVoiceCommand("enviar");
    expect(result).toEqual({ type: "action", action: "submit" });
  });

  test("'send' maps to submit action", () => {
    const result = parseVoiceCommand("send");
    expect(result).toEqual({ type: "action", action: "submit" });
  });

  test("'submit' maps to submit action", () => {
    const result = parseVoiceCommand("submit");
    expect(result).toEqual({ type: "action", action: "submit" });
  });

  test("'enviar mensaje' maps to submit action", () => {
    const result = parseVoiceCommand("enviar mensaje");
    expect(result).toEqual({ type: "action", action: "submit" });
  });

  test("'send message' maps to submit action", () => {
    const result = parseVoiceCommand("send message");
    expect(result).toEqual({ type: "action", action: "submit" });
  });

  // ─── Action: cancel ─────────────────────────────────────────

  test("'cancelar' maps to cancel action", () => {
    const result = parseVoiceCommand("cancelar");
    expect(result).toEqual({ type: "action", action: "cancel" });
  });

  test("'cancel' maps to cancel action", () => {
    const result = parseVoiceCommand("cancel");
    expect(result).toEqual({ type: "action", action: "cancel" });
  });

  test("'abort' maps to cancel action", () => {
    const result = parseVoiceCommand("abort");
    expect(result).toEqual({ type: "action", action: "cancel" });
  });

  // ─── Action: newline ────────────────────────────────────────

  test("'nuevo párrafo' maps to newline action", () => {
    const result = parseVoiceCommand("nuevo párrafo");
    expect(result).toEqual({ type: "action", action: "newline" });
  });

  test("'nuevo parrafo' (no accent) maps to newline action", () => {
    const result = parseVoiceCommand("nuevo parrafo");
    expect(result).toEqual({ type: "action", action: "newline" });
  });

  test("'new paragraph' maps to newline action", () => {
    const result = parseVoiceCommand("new paragraph");
    expect(result).toEqual({ type: "action", action: "newline" });
  });

  test("'nueva línea' maps to newline action", () => {
    const result = parseVoiceCommand("nueva línea");
    expect(result).toEqual({ type: "action", action: "newline" });
  });

  test("'new line' maps to newline action", () => {
    const result = parseVoiceCommand("new line");
    expect(result).toEqual({ type: "action", action: "newline" });
  });

  // ─── Action: clear ──────────────────────────────────────────

  test("'borrar' maps to clear action", () => {
    const result = parseVoiceCommand("borrar");
    expect(result).toEqual({ type: "action", action: "clear" });
  });

  test("'delete' maps to clear action", () => {
    const result = parseVoiceCommand("delete");
    expect(result).toEqual({ type: "action", action: "clear" });
  });

  test("'clear' maps to clear action", () => {
    const result = parseVoiceCommand("clear");
    expect(result).toEqual({ type: "action", action: "clear" });
  });

  test("'limpiar' maps to clear action", () => {
    const result = parseVoiceCommand("limpiar");
    expect(result).toEqual({ type: "action", action: "clear" });
  });

  test("'borrar todo' maps to clear action", () => {
    const result = parseVoiceCommand("borrar todo");
    expect(result).toEqual({ type: "action", action: "clear" });
  });

  // ─── Slash commands ─────────────────────────────────────────

  test("'ejecutar commit' maps to /commit", () => {
    const result = parseVoiceCommand("ejecutar commit");
    expect(result).toEqual({ type: "slash", command: "/commit" });
  });

  test("'run commit' maps to /commit", () => {
    const result = parseVoiceCommand("run commit");
    expect(result).toEqual({ type: "slash", command: "/commit" });
  });

  test("'ejecutar tests' maps to /test", () => {
    const result = parseVoiceCommand("ejecutar tests");
    expect(result).toEqual({ type: "slash", command: "/test" });
  });

  test("'run tests' maps to /test", () => {
    const result = parseVoiceCommand("run tests");
    expect(result).toEqual({ type: "slash", command: "/test" });
  });

  test("'run test' (singular) maps to /test", () => {
    const result = parseVoiceCommand("run test");
    expect(result).toEqual({ type: "slash", command: "/test" });
  });

  test("'mostrar plan' maps to /plan", () => {
    const result = parseVoiceCommand("mostrar plan");
    expect(result).toEqual({ type: "slash", command: "/plan" });
  });

  test("'show plan' maps to /plan", () => {
    const result = parseVoiceCommand("show plan");
    expect(result).toEqual({ type: "slash", command: "/plan" });
  });

  test("'compactar' maps to /compact", () => {
    const result = parseVoiceCommand("compactar");
    expect(result).toEqual({ type: "slash", command: "/compact" });
  });

  test("'compact' maps to /compact", () => {
    const result = parseVoiceCommand("compact");
    expect(result).toEqual({ type: "slash", command: "/compact" });
  });

  test("'ayuda' maps to /help", () => {
    const result = parseVoiceCommand("ayuda");
    expect(result).toEqual({ type: "slash", command: "/help" });
  });

  test("'show stats' maps to /stats", () => {
    const result = parseVoiceCommand("show stats");
    expect(result).toEqual({ type: "slash", command: "/stats" });
  });

  // ─── Case insensitivity ─────────────────────────────────────

  test("commands are case-insensitive", () => {
    expect(parseVoiceCommand("ENVIAR")).toEqual({ type: "action", action: "submit" });
    expect(parseVoiceCommand("Cancel")).toEqual({ type: "action", action: "cancel" });
    expect(parseVoiceCommand("Run Commit")).toEqual({ type: "slash", command: "/commit" });
  });

  // ─── Whitespace handling ────────────────────────────────────

  test("leading/trailing whitespace is trimmed", () => {
    expect(parseVoiceCommand("  send  ")).toEqual({ type: "action", action: "submit" });
    expect(parseVoiceCommand("\n cancelar \t")).toEqual({ type: "action", action: "cancel" });
  });

  // ─── Non-commands return null ───────────────────────────────

  test("regular text returns null", () => {
    expect(parseVoiceCommand("fix the bug in the login page")).toBeNull();
  });

  test("partial command words in sentences return null", () => {
    expect(parseVoiceCommand("please send the email later")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseVoiceCommand("")).toBeNull();
  });

  test("whitespace-only string returns null", () => {
    expect(parseVoiceCommand("   ")).toBeNull();
  });

  test("unknown command returns null", () => {
    expect(parseVoiceCommand("foobar")).toBeNull();
  });
});
