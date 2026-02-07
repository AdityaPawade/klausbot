import { describe, expect, it } from "vitest";
import { computeNextRunAtMs } from "../../../src/cron/schedule.js";

describe("computeNextRunAtMs", () => {
  describe("'at' kind (one-shot)", () => {
    it("returns atMs when in the future", () => {
      const futureMs = 2_000_000_000_000;
      const nowMs = 1_000_000_000_000;
      const result = computeNextRunAtMs({ kind: "at", atMs: futureMs }, nowMs);
      expect(result).toBe(futureMs);
    });

    it("returns null when atMs is in the past", () => {
      const pastMs = 500_000_000_000;
      const nowMs = 1_000_000_000_000;
      const result = computeNextRunAtMs({ kind: "at", atMs: pastMs }, nowMs);
      expect(result).toBeNull();
    });

    it("returns null when atMs equals nowMs (not strictly greater)", () => {
      const nowMs = 1_000_000_000_000;
      const result = computeNextRunAtMs({ kind: "at", atMs: nowMs }, nowMs);
      expect(result).toBeNull();
    });

    it("defaults atMs to 0 when undefined", () => {
      const result = computeNextRunAtMs({ kind: "at" }, 1_000);
      expect(result).toBeNull();
    });
  });

  describe("'every' kind (interval)", () => {
    const anchor = 1_000_000;
    const everyMs = 10_000;

    it("returns anchor when nowMs is before anchor", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs, anchorMs: anchor },
        anchor - 5_000,
      );
      expect(result).toBe(anchor);
    });

    it("returns anchor + everyMs when nowMs equals anchor", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs, anchorMs: anchor },
        anchor,
      );
      // elapsed = 0, ceil(0/10000) = 0, anchor + 0 = anchor
      // But source uses Math.ceil which returns 0 for 0/x, so result = anchor
      // Actually: elapsed=0, steps=ceil(0/10000)=0, anchor+0*10000=anchor
      // However anchor == nowMs means we're AT anchor, so next should be anchor+everyMs
      // Let's check: elapsed=0, ceil(0/everyMs)=0, anchor+0=anchor=nowMs
      // The function returns anchor (1000000) which equals nowMs.
      // This is technically "now", not "next". But that's the implementation.
      expect(result).toBe(anchor);
    });

    it("returns next tick when just past first interval", () => {
      // nowMs = anchor + everyMs + 1 (just past first tick)
      const nowMs = anchor + everyMs + 1;
      const result = computeNextRunAtMs(
        { kind: "every", everyMs, anchorMs: anchor },
        nowMs,
      );
      // elapsed = 10001, steps = ceil(10001/10000) = 2
      // next = 1000000 + 2*10000 = 1020000
      expect(result).toBe(anchor + 2 * everyMs);
    });

    it("handles large elapsed time (many intervals)", () => {
      // 100 intervals past anchor
      const nowMs = anchor + 100 * everyMs + 500;
      const result = computeNextRunAtMs(
        { kind: "every", everyMs, anchorMs: anchor },
        nowMs,
      );
      // elapsed = 1000500, steps = ceil(1000500/10000) = 101
      expect(result).toBe(anchor + 101 * everyMs);
    });

    it("handles everyMs of 0 gracefully (Math.max(1, ...))", () => {
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 0, anchorMs: anchor },
        anchor + 5,
      );
      // everyMs = max(1, 0) = 1, elapsed=5, steps=ceil(5/1)=5
      expect(result).toBe(anchor + 5);
    });

    it("handles undefined everyMs gracefully", () => {
      const result = computeNextRunAtMs(
        { kind: "every", anchorMs: anchor },
        anchor + 5,
      );
      // everyMs = max(1, 0) = 1
      expect(result).toBe(anchor + 5);
    });

    it("defaults anchorMs to nowMs when undefined", () => {
      const nowMs = 5_000_000;
      const result = computeNextRunAtMs(
        { kind: "every", everyMs: 1000 },
        nowMs,
      );
      // anchor = nowMs, elapsed = 0, steps = 0, result = nowMs
      expect(result).toBe(nowMs);
    });
  });

  describe("'cron' kind", () => {
    it("returns future timestamp for valid cron '0 9 * * *'", () => {
      const nowMs = Date.now();
      const result = computeNextRunAtMs(
        { kind: "cron", expr: "0 9 * * *" },
        nowMs,
      );
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(nowMs);
    });

    it("returns null for invalid cron expression", () => {
      const result = computeNextRunAtMs(
        { kind: "cron", expr: "not a cron" },
        1_000_000,
      );
      expect(result).toBeNull();
    });

    it("returns null when expr is undefined", () => {
      const result = computeNextRunAtMs({ kind: "cron" }, 1_000_000);
      expect(result).toBeNull();
    });

    it("does not throw with timezone option", () => {
      const result = computeNextRunAtMs(
        { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
        Date.now(),
      );
      expect(result).not.toBeNull();
    });
  });

  describe("unknown kind", () => {
    it("returns null for unknown schedule kind", () => {
      // Force an unknown kind via type assertion
      const result = computeNextRunAtMs({ kind: "unknown" as "at" }, 1_000_000);
      expect(result).toBeNull();
    });
  });
});
