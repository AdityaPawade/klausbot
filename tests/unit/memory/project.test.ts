import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// We need to mock KLAUSBOT_HOME before importing project.ts
// Create a real temp directory for each test

let testHome: string;

// Mock home.ts to use our temp directory
vi.mock("../../../src/memory/home.js", () => {
  // Return a proxy that reads testHome at call time
  return {
    get KLAUSBOT_HOME() {
      return testHome;
    },
    DIRS: ["config", "identity", "cron", "images", "logs"] as const,
    setProjectHomeOverride: vi.fn(),
    getProjectHomeOverride: vi.fn(),
    getHomePath: (...segments: string[]) => {
      // Simplified: no project awareness in the mock (tested separately)
      return [testHome, ...segments].join("/");
    },
  };
});

import {
  sanitizeProjectName,
  getActiveProject,
  setActiveProject,
  listProjects,
  projectExists,
  getProjectHome,
  resetProjectState,
  reloadProjectState,
  initializeProjectDirs,
} from "../../../src/memory/project.js";
import { setProjectHomeOverride } from "../../../src/memory/home.js";

describe("project management", () => {
  beforeEach(() => {
    testHome = join(tmpdir(), `klausbot-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(testHome, { recursive: true });
    resetProjectState();
    vi.mocked(setProjectHomeOverride).mockClear();
  });

  afterEach(() => {
    resetProjectState();
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  describe("sanitizeProjectName", () => {
    it("converts to lowercase", () => {
      expect(sanitizeProjectName("MyProject")).toBe("myproject");
    });

    it("replaces spaces and special chars with hyphens", () => {
      expect(sanitizeProjectName("My Cool Project!")).toBe("my-cool-project");
    });

    it("collapses multiple hyphens", () => {
      expect(sanitizeProjectName("a--b---c")).toBe("a-b-c");
    });

    it("strips leading/trailing hyphens", () => {
      expect(sanitizeProjectName("-test-")).toBe("test");
    });

    it("returns null for empty string", () => {
      expect(sanitizeProjectName("")).toBeNull();
    });

    it("returns null for all-special-char string", () => {
      expect(sanitizeProjectName("!!!")).toBeNull();
    });

    it("preserves numbers", () => {
      expect(sanitizeProjectName("project-123")).toBe("project-123");
    });

    it("handles already clean names", () => {
      expect(sanitizeProjectName("cubone-sdk")).toBe("cubone-sdk");
    });
  });

  describe("getActiveProject", () => {
    it("returns null by default (no project active)", () => {
      expect(getActiveProject()).toBeNull();
    });

    it("returns null when state file does not exist", () => {
      reloadProjectState();
      expect(getActiveProject()).toBeNull();
    });

    it("loads persisted active project from disk", () => {
      const projectsDir = join(testHome, "projects");
      mkdirSync(projectsDir, { recursive: true });
      // Also create the project directory so it's valid
      mkdirSync(join(projectsDir, "test-project"), { recursive: true });
      writeFileSync(
        join(projectsDir, "projects.json"),
        JSON.stringify({ activeProject: "test-project" }),
      );

      reloadProjectState();
      expect(getActiveProject()).toBe("test-project");
    });

    it("handles corrupted state file gracefully", () => {
      const projectsDir = join(testHome, "projects");
      mkdirSync(projectsDir, { recursive: true });
      writeFileSync(join(projectsDir, "projects.json"), "NOT JSON{{{");

      reloadProjectState();
      expect(getActiveProject()).toBeNull();
    });
  });

  describe("setActiveProject", () => {
    it("sets project and persists to disk", () => {
      const result = setActiveProject("my-project");
      expect(result).toBe(true);
      expect(getActiveProject()).toBe("my-project");

      // Verify persisted
      const statePath = join(testHome, "projects", "projects.json");
      expect(existsSync(statePath)).toBe(true);
    });

    it("sanitizes the project name", () => {
      setActiveProject("My Project");
      expect(getActiveProject()).toBe("my-project");
    });

    it("returns false for invalid name", () => {
      const result = setActiveProject("!!!");
      expect(result).toBe(false);
      expect(getActiveProject()).toBeNull();
    });

    it("creates project directories", () => {
      setActiveProject("new-proj");
      const projectHome = join(testHome, "projects", "new-proj");
      expect(existsSync(projectHome)).toBe(true);
      expect(existsSync(join(projectHome, "identity"))).toBe(true);
      expect(existsSync(join(projectHome, "logs"))).toBe(true);
      expect(existsSync(join(projectHome, "images"))).toBe(true);
      expect(existsSync(join(projectHome, "cron"))).toBe(true);
      expect(existsSync(join(projectHome, "tasks", "active"))).toBe(true);
      expect(existsSync(join(projectHome, "tasks", "completed"))).toBe(true);
      expect(existsSync(join(projectHome, "tasks", "notified"))).toBe(true);
    });

    it("does NOT create config dir in project (config is global)", () => {
      setActiveProject("new-proj");
      const projectHome = join(testHome, "projects", "new-proj");
      expect(existsSync(join(projectHome, "config"))).toBe(false);
    });

    it("deselects project with null", () => {
      setActiveProject("some-project");
      expect(getActiveProject()).toBe("some-project");

      const result = setActiveProject(null);
      expect(result).toBe(true);
      expect(getActiveProject()).toBeNull();
    });

    it("calls setProjectHomeOverride when activating", () => {
      setActiveProject("test-proj");
      expect(setProjectHomeOverride).toHaveBeenCalledWith(
        join(testHome, "projects", "test-proj"),
      );
    });

    it("calls setProjectHomeOverride(null) when deactivating", () => {
      setActiveProject("test-proj");
      vi.mocked(setProjectHomeOverride).mockClear();

      setActiveProject(null);
      expect(setProjectHomeOverride).toHaveBeenCalledWith(null);
    });

    it("switching projects updates override to new path", () => {
      setActiveProject("project-a");
      vi.mocked(setProjectHomeOverride).mockClear();

      setActiveProject("project-b");
      expect(setProjectHomeOverride).toHaveBeenCalledWith(
        join(testHome, "projects", "project-b"),
      );
    });
  });

  describe("listProjects", () => {
    it("returns empty array when no projects exist", () => {
      expect(listProjects()).toEqual([]);
    });

    it("returns empty array when projects dir does not exist", () => {
      expect(listProjects()).toEqual([]);
    });

    it("lists project directories sorted alphabetically", () => {
      const projectsDir = join(testHome, "projects");
      mkdirSync(join(projectsDir, "beta"), { recursive: true });
      mkdirSync(join(projectsDir, "alpha"), { recursive: true });
      mkdirSync(join(projectsDir, "gamma"), { recursive: true });

      expect(listProjects()).toEqual(["alpha", "beta", "gamma"]);
    });

    it("ignores non-directory entries", () => {
      const projectsDir = join(testHome, "projects");
      mkdirSync(projectsDir, { recursive: true });
      writeFileSync(join(projectsDir, "projects.json"), "{}");
      mkdirSync(join(projectsDir, "real-project"), { recursive: true });

      expect(listProjects()).toEqual(["real-project"]);
    });
  });

  describe("projectExists", () => {
    it("returns false for non-existent project", () => {
      expect(projectExists("nonexistent")).toBe(false);
    });

    it("returns true for existing project", () => {
      setActiveProject("existing");
      expect(projectExists("existing")).toBe(true);
    });

    it("returns false for invalid name", () => {
      expect(projectExists("!!!")).toBe(false);
    });

    it("sanitizes name before checking", () => {
      setActiveProject("My Project");
      expect(projectExists("My Project")).toBe(true);
      expect(projectExists("my-project")).toBe(true);
    });
  });

  describe("getProjectHome", () => {
    it("returns path under projects directory", () => {
      const result = getProjectHome("test");
      expect(result).toBe(join(testHome, "projects", "test"));
    });
  });

  describe("initializeProjectDirs", () => {
    it("is idempotent — can be called multiple times", () => {
      initializeProjectDirs("idempotent-test");
      initializeProjectDirs("idempotent-test");
      const projectHome = join(testHome, "projects", "idempotent-test");
      expect(existsSync(projectHome)).toBe(true);
    });
  });

  describe("state persistence roundtrip", () => {
    it("survives reset + reload cycle", () => {
      setActiveProject("persistent-proj");
      expect(getActiveProject()).toBe("persistent-proj");

      // Simulate process restart
      resetProjectState();
      expect(getActiveProject()).toBeNull(); // reset clears in-memory

      reloadProjectState();
      expect(getActiveProject()).toBe("persistent-proj"); // reloaded from disk
    });

    it("null project persists correctly", () => {
      setActiveProject("temp-proj");
      setActiveProject(null);

      resetProjectState();
      reloadProjectState();
      expect(getActiveProject()).toBeNull();
    });
  });
});
