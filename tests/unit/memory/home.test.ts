import { describe, expect, it, beforeEach } from "vitest";
import { join } from "path";
import {
  KLAUSBOT_HOME,
  getHomePath,
  setProjectHomeOverride,
  getProjectHomeOverride,
} from "../../../src/memory/home.js";

describe("getHomePath", () => {
  beforeEach(() => {
    // Reset to global
    setProjectHomeOverride(null);
  });

  describe("without project override (global mode)", () => {
    it("returns KLAUSBOT_HOME with no segments", () => {
      expect(getHomePath()).toBe(KLAUSBOT_HOME);
    });

    it("joins segments with KLAUSBOT_HOME", () => {
      expect(getHomePath("klausbot.db")).toBe(
        join(KLAUSBOT_HOME, "klausbot.db"),
      );
    });

    it("joins nested segments", () => {
      expect(getHomePath("identity", "SOUL.md")).toBe(
        join(KLAUSBOT_HOME, "identity", "SOUL.md"),
      );
    });

    it("config path resolves to KLAUSBOT_HOME", () => {
      expect(getHomePath("config", "pairing.json")).toBe(
        join(KLAUSBOT_HOME, "config", "pairing.json"),
      );
    });
  });

  describe("with project override", () => {
    const projectHome = "/tmp/test-projects/my-project";

    beforeEach(() => {
      setProjectHomeOverride(projectHome);
    });

    it("resolves non-global paths to project home", () => {
      expect(getHomePath("klausbot.db")).toBe(join(projectHome, "klausbot.db"));
    });

    it("resolves identity paths to project home", () => {
      expect(getHomePath("identity", "SOUL.md")).toBe(
        join(projectHome, "identity", "SOUL.md"),
      );
    });

    it("resolves logs to project home", () => {
      expect(getHomePath("logs", "gateway.log")).toBe(
        join(projectHome, "logs", "gateway.log"),
      );
    });

    it("resolves cron to project home", () => {
      expect(getHomePath("cron", "jobs.json")).toBe(
        join(projectHome, "cron", "jobs.json"),
      );
    });

    it("resolves images to project home", () => {
      expect(getHomePath("images", "2026-03-09")).toBe(
        join(projectHome, "images", "2026-03-09"),
      );
    });

    it("config ALWAYS resolves to global KLAUSBOT_HOME", () => {
      expect(getHomePath("config", "pairing.json")).toBe(
        join(KLAUSBOT_HOME, "config", "pairing.json"),
      );
    });

    it("config is global even with nested paths", () => {
      expect(getHomePath("config", "klausbot.json")).toBe(
        join(KLAUSBOT_HOME, "config", "klausbot.json"),
      );
    });

    it("no segments returns project home", () => {
      expect(getHomePath()).toBe(projectHome);
    });
  });

  describe("setProjectHomeOverride / getProjectHomeOverride", () => {
    it("starts as null", () => {
      expect(getProjectHomeOverride()).toBeNull();
    });

    it("can be set and read back", () => {
      setProjectHomeOverride("/tmp/proj");
      expect(getProjectHomeOverride()).toBe("/tmp/proj");
    });

    it("can be reset to null", () => {
      setProjectHomeOverride("/tmp/proj");
      setProjectHomeOverride(null);
      expect(getProjectHomeOverride()).toBeNull();
    });
  });

  describe("switching projects changes path resolution", () => {
    it("paths change when override changes", () => {
      // Global
      const globalDb = getHomePath("klausbot.db");
      expect(globalDb).toBe(join(KLAUSBOT_HOME, "klausbot.db"));

      // Switch to project A
      setProjectHomeOverride("/tmp/projects/project-a");
      const projectADb = getHomePath("klausbot.db");
      expect(projectADb).toBe("/tmp/projects/project-a/klausbot.db");

      // Switch to project B
      setProjectHomeOverride("/tmp/projects/project-b");
      const projectBDb = getHomePath("klausbot.db");
      expect(projectBDb).toBe("/tmp/projects/project-b/klausbot.db");

      // Back to global
      setProjectHomeOverride(null);
      const globalAgain = getHomePath("klausbot.db");
      expect(globalAgain).toBe(join(KLAUSBOT_HOME, "klausbot.db"));
    });

    it("config stays global through all switches", () => {
      const expected = join(KLAUSBOT_HOME, "config", "pairing.json");

      expect(getHomePath("config", "pairing.json")).toBe(expected);

      setProjectHomeOverride("/tmp/proj-a");
      expect(getHomePath("config", "pairing.json")).toBe(expected);

      setProjectHomeOverride("/tmp/proj-b");
      expect(getHomePath("config", "pairing.json")).toBe(expected);

      setProjectHomeOverride(null);
      expect(getHomePath("config", "pairing.json")).toBe(expected);
    });
  });
});
