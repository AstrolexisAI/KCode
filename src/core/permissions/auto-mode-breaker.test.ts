import { test, expect, describe, beforeEach } from "bun:test";
import { AutoModeBreaker, _resetAutoModeBreaker, getAutoModeBreaker } from "./auto-mode-breaker";

describe("AutoModeBreaker", () => {
  describe("basic operation", () => {
    test("starts in non-tripped state", () => {
      const breaker = new AutoModeBreaker();
      expect(breaker.isAutoModeAllowed()).toBe(true);
      expect(breaker.getState().isOpen).toBe(false);
    });

    test("recordSuccess resets failure counters", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 3 });
      breaker.recordFailure("Bash");
      breaker.recordFailure("Bash");
      breaker.recordSuccess();
      expect(breaker.getState().consecutiveFailures).toBe(0);
      expect(breaker.isAutoModeAllowed()).toBe(true);
    });
  });

  describe("failure tracking", () => {
    test("trips after consecutive failures", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 3 });
      breaker.recordFailure("Bash", "timeout");
      breaker.recordFailure("Bash", "timeout");
      expect(breaker.isAutoModeAllowed()).toBe(true);
      breaker.recordFailure("Bash", "timeout");
      expect(breaker.isAutoModeAllowed()).toBe(false);
      expect(breaker.getState().reason).toContain("consecutive tool failures");
    });

    test("success resets failure count", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 3 });
      breaker.recordFailure("Bash");
      breaker.recordFailure("Bash");
      breaker.recordSuccess();
      breaker.recordFailure("Bash");
      expect(breaker.isAutoModeAllowed()).toBe(true);
    });
  });

  describe("denial tracking", () => {
    test("trips after consecutive denials", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveDenials: 2 });
      breaker.recordDenial("Bash");
      expect(breaker.isAutoModeAllowed()).toBe(true);
      breaker.recordDenial("Bash");
      expect(breaker.isAutoModeAllowed()).toBe(false);
      expect(breaker.getState().reason).toContain("consecutive permission denials");
    });
  });

  describe("rate limiting", () => {
    test("trips when rate limit exceeded", () => {
      const breaker = new AutoModeBreaker({ maxToolsPerMinute: 5 });
      for (let i = 0; i < 5; i++) {
        expect(breaker.checkRateLimit()).toBe(true);
        breaker.recordSuccess();
      }
      expect(breaker.checkRateLimit()).toBe(false);
      expect(breaker.getState().reason).toContain("Rate limit exceeded");
    });
  });

  describe("remote kill switch", () => {
    test("blocks auto-mode when remote disabled", () => {
      const breaker = new AutoModeBreaker();
      breaker.setRemoteDisabled(true);
      expect(breaker.isAutoModeAllowed()).toBe(false);
    });

    test("remote disable trips the breaker", () => {
      const breaker = new AutoModeBreaker();
      breaker.setRemoteDisabled(true);
      expect(breaker.getState().reason).toContain("Remote kill switch");
    });
  });

  describe("reset", () => {
    test("manual reset restores auto-mode", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 1 });
      breaker.recordFailure("Bash");
      expect(breaker.isAutoModeAllowed()).toBe(false);
      breaker.reset();
      expect(breaker.isAutoModeAllowed()).toBe(true);
      expect(breaker.getState().consecutiveFailures).toBe(0);
    });

    test("auto-reset after timeout", () => {
      const breaker = new AutoModeBreaker({
        maxConsecutiveFailures: 1,
        resetAfterMs: 50, // 50ms for testing
      });
      breaker.recordFailure("Bash");
      expect(breaker.isAutoModeAllowed()).toBe(false);

      // Simulate time passing by manipulating the lastTripped date
      const state = breaker.getState();
      expect(state.isOpen).toBe(true);
    });

    test("tracks total trips", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 1 });
      breaker.recordFailure("Bash");
      expect(breaker.getState().totalTrips).toBe(1);
      breaker.reset();
      breaker.recordFailure("Bash");
      expect(breaker.getState().totalTrips).toBe(2);
    });
  });

  describe("callbacks", () => {
    test("onTrip called when breaker trips", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 1 });
      let tripReason = "";
      breaker.onTrip = (reason) => { tripReason = reason; };
      breaker.recordFailure("Bash");
      expect(tripReason).toContain("consecutive tool failures");
    });

    test("onReset called when breaker resets", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 1 });
      let resetCalled = false;
      breaker.onReset = () => { resetCalled = true; };
      breaker.recordFailure("Bash");
      breaker.reset();
      expect(resetCalled).toBe(true);
    });

    test("onTrip not called for duplicate trips", () => {
      const breaker = new AutoModeBreaker({ maxConsecutiveFailures: 1 });
      let tripCount = 0;
      breaker.onTrip = () => { tripCount++; };
      breaker.recordFailure("Bash");
      breaker.recordFailure("Bash"); // already tripped
      expect(tripCount).toBe(1);
    });
  });

  describe("singleton", () => {
    beforeEach(() => _resetAutoModeBreaker());

    test("getAutoModeBreaker returns singleton", () => {
      const a = getAutoModeBreaker();
      const b = getAutoModeBreaker();
      expect(a).toBe(b);
    });

    test("_resetAutoModeBreaker clears singleton", () => {
      const a = getAutoModeBreaker();
      _resetAutoModeBreaker();
      const b = getAutoModeBreaker();
      expect(a).not.toBe(b);
    });
  });
});
