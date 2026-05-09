// KCode - Tests for give-up-detector
import { describe, expect, test } from "bun:test";
import { detectGiveUp, formatEscalationNotice } from "./give-up-detector";

describe("detectGiveUp", () => {
  test("returns null when the model issued any tool call", () => {
    expect(detectGiveUp("hay restricciones en el entorno", 1)).toBeNull();
    expect(detectGiveUp("no puedo ejecutar esto", 3)).toBeNull();
  });

  test("returns null on plain chat answers", () => {
    expect(detectGiveUp("REST is an architectural style for HTTP APIs.", 0)).toBeNull();
    expect(detectGiveUp("Hola, ¿en qué puedo ayudarte?", 0)).toBeNull();
    expect(detectGiveUp("La capital de Francia es París.", 0)).toBeNull();
  });

  test("flags Spanish 'restricciones en el entorno' hallucination", () => {
    expect(
      detectGiveUp(
        "Lo siento, parece que hay restricciones en el entorno de ejecución que impiden el uso de comandos.",
        0,
      ),
    ).not.toBeNull();
  });

  test("flags 'tools restringidas' anywhere in the text", () => {
    expect(detectGiveUp("Las herramientas están restringidas en este entorno.", 0)).not.toBeNull();
  });

  test("flags 'restricciones de seguridad' generic hallucination", () => {
    expect(
      detectGiveUp(
        "Debido a las restricciones de seguridad del entorno (sandbox), los comandos están bloqueados.",
        0,
      ),
    ).not.toBeNull();
  });

  test("flags English 'environment is restricted'", () => {
    expect(
      detectGiveUp("The environment is restricted and I can't run network commands.", 0),
    ).not.toBeNull();
  });

  test("flags 'I do not have access to'", () => {
    expect(
      detectGiveUp("I do not have access to your network, please paste the output here.", 0),
    ).not.toBeNull();
  });

  test("flags 'please paste the output'", () => {
    expect(
      detectGiveUp("Please paste the result of arp -a here so I can analyze the devices.", 0),
    ).not.toBeNull();
  });

  test("flags Spanish 'pegame el resultado' (with or without accent)", () => {
    expect(detectGiveUp("Por favor, pegame el resultado del comando aquí.", 0)).not.toBeNull();
  });

  test("flags 'no puedo ejecutar'", () => {
    expect(detectGiveUp("No puedo ejecutar ese comando en este entorno.", 0)).not.toBeNull();
  });

  test("flags 'I'm unable to execute'", () => {
    expect(
      detectGiveUp("I'm unable to execute system commands in this sandbox.", 0),
    ).not.toBeNull();
  });

  test("includes a snippet of the matched text in the reason", () => {
    const r = detectGiveUp("Debido a las restricciones del entorno, no puedo seguir.", 0);
    expect(r?.reason).toMatch(/Model wrote a give-up signature/);
    expect(r?.reason).toMatch(/restricciones/);
  });

  test("known limitation: phrases like 'restricciones de seguridad' fire even in benign explanations", () => {
    // Documented trade-off: the loose patterns over-match a few chat
    // explanations. Caller (router) should also gate on multimodel
    // being enabled AND ideally on the prompt being tool-worthy
    // before escalating.
    expect(detectGiveUp("Una red WiFi puede tener restricciones de seguridad.", 0)).not.toBeNull();
  });
});

describe("formatEscalationNotice", () => {
  test("includes both model names + signature in the warning", () => {
    const notice = formatEscalationNotice("local-gemma", "claude-haiku", {
      reason: "Model gave up.",
      signature: "tools-restricted",
    });
    expect(notice).toMatch(/local-gemma/);
    expect(notice).toMatch(/claude-haiku/);
    expect(notice).toMatch(/tools-restricted/);
    expect(notice).toMatch(/⇪ Auto-escalating/);
  });
});
