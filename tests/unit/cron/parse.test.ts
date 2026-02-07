import { describe, expect, it } from "vitest";
import { parseSchedule } from "../../../src/cron/parse.js";

describe("parseSchedule", () => {
  describe("interval patterns", () => {
    it("parses 'every 5 minutes'", () => {
      const result = parseSchedule("every 5 minutes");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      expect(result!.schedule.everyMs).toBe(300_000);
      expect(result!.humanReadable).toContain("5 minute");
    });

    it("parses 'every 1 hour' without plural", () => {
      const result = parseSchedule("every 1 hour");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      expect(result!.schedule.everyMs).toBe(3_600_000);
      expect(result!.humanReadable).toBe("every 1 hour");
    });

    it("parses 'every 2 days'", () => {
      const result = parseSchedule("every 2 days");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      expect(result!.schedule.everyMs).toBe(172_800_000);
    });

    it("parses 'every 1 second'", () => {
      const result = parseSchedule("every 1 second");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      expect(result!.schedule.everyMs).toBe(1000);
    });

    it("parses 'every 3 weeks'", () => {
      const result = parseSchedule("every 3 weeks");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      expect(result!.schedule.everyMs).toBe(3 * 7 * 24 * 60 * 60 * 1000);
    });

    it("sets nextRun to a future date for intervals", () => {
      const result = parseSchedule("every 10 minutes");
      expect(result).not.toBeNull();
      expect(result!.nextRun).toBeInstanceOf(Date);
      expect(result!.nextRun!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("daily patterns", () => {
    it("parses 'every day at 9am' to cron", () => {
      const result = parseSchedule("every day at 9am");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("0 9 * * *");
    });

    it("parses 'daily at 2:30pm' to cron", () => {
      const result = parseSchedule("daily at 2:30pm");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("30 14 * * *");
    });

    it("handles 12am midnight edge case", () => {
      const result = parseSchedule("every day at 12am");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("0 0 * * *");
    });

    it("handles 12pm noon edge case", () => {
      const result = parseSchedule("every day at 12pm");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("0 12 * * *");
    });

    it("sets nextRun for daily schedules", () => {
      const result = parseSchedule("every day at 9am");
      expect(result).not.toBeNull();
      expect(result!.nextRun).toBeInstanceOf(Date);
    });
  });

  describe("weekday patterns", () => {
    it("parses 'every weekday at 8am'", () => {
      const result = parseSchedule("every weekday at 8am");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("0 8 * * 1-5");
    });

    it("parses 'every weekday at 5:30pm'", () => {
      const result = parseSchedule("every weekday at 5:30pm");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("30 17 * * 1-5");
    });

    it("includes 'weekday' in humanReadable", () => {
      const result = parseSchedule("every weekday at 8am");
      expect(result).not.toBeNull();
      expect(result!.humanReadable).toContain("weekday");
    });
  });

  describe("raw cron expressions", () => {
    it("parses '30 8 * * 1-5' as cron", () => {
      const result = parseSchedule("30 8 * * 1-5");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("30 8 * * 1-5");
    });

    it("parses '0 0 * * 0' (weekly Sunday midnight)", () => {
      const result = parseSchedule("0 0 * * 0");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
      expect(result!.schedule.expr).toBe("0 0 * * 0");
    });

    it("parses '*/5 * * * *' (every 5 min cron)", () => {
      const result = parseSchedule("*/5 * * * *");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
    });

    it("sets humanReadable for raw cron", () => {
      const result = parseSchedule("30 8 * * 1-5");
      expect(result).not.toBeNull();
      expect(result!.humanReadable).toContain("cron:");
    });
  });

  describe("null / invalid cases", () => {
    it("returns null for gibberish", () => {
      expect(parseSchedule("gobbledygook")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseSchedule("")).toBeNull();
    });

    it("returns null for 'every 0 minutes' (count must be > 0)", () => {
      expect(parseSchedule("every 0 minutes")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("handles uppercase input", () => {
      const result = parseSchedule("EVERY 5 MINUTES");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
    });

    it("handles mixed case", () => {
      const result = parseSchedule("Every Day At 9AM");
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
    });
  });
});
