import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

let testHome: string;
let globalDbPath: string;
let projectDbPath: string;

// Mock home.ts — we control the override directly via setProjectHomeOverride
vi.mock("../../../src/memory/home.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  let override: string | null = null;

  return {
    ...actual,
    get KLAUSBOT_HOME() {
      return testHome;
    },
    setProjectHomeOverride: (path: string | null) => {
      override = path;
    },
    getProjectHomeOverride: () => override,
    getHomePath: (...segments: string[]) => {
      const globalSegments = new Set(["config"]);
      if (
        !override ||
        (segments.length > 0 && globalSegments.has(segments[0]))
      ) {
        return [testHome, ...segments].join("/");
      }
      return [override, ...segments].join("/");
    },
  };
});

import {
  getDb,
  getDrizzle,
  closeDb,
  switchDb,
  runMigrations,
  getCurrentDbPath,
} from "../../../src/memory/db.js";
import { setProjectHomeOverride } from "../../../src/memory/home.js";

describe("database connection switching", () => {
  beforeEach(() => {
    testHome = join(tmpdir(), `klausbot-db-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(testHome, { recursive: true });
    globalDbPath = join(testHome, "klausbot.db");

    const projectDir = join(testHome, "projects", "test-project");
    mkdirSync(projectDir, { recursive: true });
    projectDbPath = join(projectDir, "klausbot.db");

    // Start in global mode
    setProjectHomeOverride(null);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    setProjectHomeOverride(null);
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("opens global DB by default", () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(getCurrentDbPath()).toBe(globalDbPath);
    expect(existsSync(globalDbPath)).toBe(true);
  });

  it("getDrizzle wraps getDb", () => {
    const drizzle = getDrizzle();
    expect(drizzle).toBeDefined();
    expect(getCurrentDbPath()).toBe(globalDbPath);
  });

  it("switchDb closes current and opens new on next access", () => {
    // Open global DB
    getDb();
    expect(getCurrentDbPath()).toBe(globalDbPath);

    // Switch to project
    setProjectHomeOverride(join(testHome, "projects", "test-project"));
    switchDb();
    expect(getCurrentDbPath()).toBeNull(); // closed, not yet reopened

    // Next getDb() opens project DB
    getDb();
    expect(getCurrentDbPath()).toBe(projectDbPath);
    expect(existsSync(projectDbPath)).toBe(true);
  });

  it("both DBs are independent — data written to one does not appear in the other", () => {
    // Write to global DB
    getDb();
    runMigrations();
    const globalDrizzle = getDrizzle();
    getDb().exec(`
      INSERT INTO conversations (session_id, started_at, ended_at, transcript, summary, message_count, chat_id)
      VALUES ('global-session', '2026-01-01', '2026-01-01', '{}', 'global data', 1, 123)
    `);

    // Switch to project
    setProjectHomeOverride(join(testHome, "projects", "test-project"));
    switchDb();
    getDb();
    runMigrations();

    // Project DB should be empty
    const rows = getDb()
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get() as { count: number };
    expect(rows.count).toBe(0);

    // Switch back to global
    setProjectHomeOverride(null);
    switchDb();
    getDb();

    // Global DB should still have data
    const globalRows = getDb()
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get() as { count: number };
    expect(globalRows.count).toBe(1);
  });

  it("switchDb is safe to call when no DB is open", () => {
    // Should not throw
    switchDb();
    expect(getCurrentDbPath()).toBeNull();
  });

  it("switchDb + runMigrations initializes new DB with all tables", () => {
    setProjectHomeOverride(join(testHome, "projects", "test-project"));
    switchDb();
    getDb();
    runMigrations();

    const db = getDb();
    // Check conversations table exists
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'",
      )
      .all();
    expect(tables).toHaveLength(1);

    // Check embeddings table exists
    const embTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'",
      )
      .all();
    expect(embTables).toHaveLength(1);
  });

  it("closeDb resets all cached instances", () => {
    getDb();
    getDrizzle();
    expect(getCurrentDbPath()).toBe(globalDbPath);

    closeDb();
    expect(getCurrentDbPath()).toBeNull();

    // Next access creates fresh instance
    const db = getDb();
    expect(db).toBeDefined();
    expect(getCurrentDbPath()).toBe(globalDbPath);
  });

  it("rapid switching between projects works correctly", () => {
    const projectA = join(testHome, "projects", "project-a");
    const projectB = join(testHome, "projects", "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    // Global
    getDb();
    runMigrations();
    getDb().exec(`
      INSERT INTO conversations (session_id, started_at, ended_at, transcript, summary, message_count)
      VALUES ('g1', '2026-01-01', '2026-01-01', '{}', 'global', 1)
    `);

    // Project A
    setProjectHomeOverride(projectA);
    switchDb();
    getDb();
    runMigrations();
    getDb().exec(`
      INSERT INTO conversations (session_id, started_at, ended_at, transcript, summary, message_count)
      VALUES ('a1', '2026-01-01', '2026-01-01', '{}', 'project-a', 1)
    `);

    // Project B
    setProjectHomeOverride(projectB);
    switchDb();
    getDb();
    runMigrations();
    getDb().exec(`
      INSERT INTO conversations (session_id, started_at, ended_at, transcript, summary, message_count)
      VALUES ('b1', '2026-01-01', '2026-01-01', '{}', 'project-b', 1)
    `);
    getDb().exec(`
      INSERT INTO conversations (session_id, started_at, ended_at, transcript, summary, message_count)
      VALUES ('b2', '2026-01-01', '2026-01-01', '{}', 'project-b-2', 1)
    `);

    // Verify project B has 2 rows
    const bCount = (
      getDb().prepare("SELECT COUNT(*) as count FROM conversations").get() as {
        count: number;
      }
    ).count;
    expect(bCount).toBe(2);

    // Back to global
    setProjectHomeOverride(null);
    switchDb();
    getDb();
    const gCount = (
      getDb().prepare("SELECT COUNT(*) as count FROM conversations").get() as {
        count: number;
      }
    ).count;
    expect(gCount).toBe(1);

    // Back to project A
    setProjectHomeOverride(projectA);
    switchDb();
    getDb();
    const aCount = (
      getDb().prepare("SELECT COUNT(*) as count FROM conversations").get() as {
        count: number;
      }
    ).count;
    expect(aCount).toBe(1);
    const aRow = getDb().prepare("SELECT summary FROM conversations").get() as {
      summary: string;
    };
    expect(aRow.summary).toBe("project-a");
  });
});
