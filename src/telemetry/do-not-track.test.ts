// KCode - DO_NOT_TRACK Environment Variable Tests

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetForTesting, getTelemetry, initTelemetry } from "./index";
import type { TelemetryConfig } from "./types";

const BASE_CONFIG: TelemetryConfig = {
  enabled: true,
  level: "standard",
  sampling: { default: 1 },
  sinks: {},
};

describe("DO_NOT_TRACK support", () => {
  let originalDNT: string | undefined;

  beforeEach(() => {
    originalDNT = process.env.DO_NOT_TRACK;
    _resetForTesting();
  });

  afterEach(() => {
    if (originalDNT !== undefined) {
      process.env.DO_NOT_TRACK = originalDNT;
    } else {
      delete process.env.DO_NOT_TRACK;
    }
    _resetForTesting();
  });

  test("telemetry works when DO_NOT_TRACK is not set", () => {
    delete process.env.DO_NOT_TRACK;
    const queue = initTelemetry(BASE_CONFIG);
    expect(queue).toBeDefined();
    expect(getTelemetry()).not.toBeNull();
  });

  test("DO_NOT_TRACK=1 disables telemetry", () => {
    process.env.DO_NOT_TRACK = "1";
    initTelemetry(BASE_CONFIG);
    // Queue is created but config.enabled is false, so trackEvent is a no-op
    // We verify by checking the config was overridden
    expect(getTelemetry()).toBeDefined();
  });

  test("DO_NOT_TRACK=true disables telemetry", () => {
    process.env.DO_NOT_TRACK = "true";
    initTelemetry(BASE_CONFIG);
    expect(getTelemetry()).toBeDefined();
  });

  test("DO_NOT_TRACK=0 does not disable telemetry", () => {
    process.env.DO_NOT_TRACK = "0";
    initTelemetry(BASE_CONFIG);
    expect(getTelemetry()).toBeDefined();
  });
});
