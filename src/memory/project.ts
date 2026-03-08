/**
 * Project management — per-project data isolation
 *
 * When a project is active, getHomePath() resolves to
 * ~/.klausbot/projects/<name>/ instead of ~/.klausbot/
 *
 * Global resources (config, pairing, queue) stay in ~/.klausbot/
 * Per-project resources (db, identity, tasks, images, cron, logs) are isolated.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readdirSync } from "fs";
import { join } from "path";
import { KLAUSBOT_HOME, DIRS, setProjectHomeOverride } from "./home.js";

/** State file: ~/.klausbot/projects/projects.json */
const PROJECTS_DIR = join(KLAUSBOT_HOME, "projects");
const STATE_PATH = join(PROJECTS_DIR, "projects.json");

/** Persisted project state */
interface ProjectState {
  /** Currently active project name, or null for global */
  activeProject: string | null;
}

/** In-memory active project name */
let activeProject: string | null = null;
let stateLoaded = false;

/**
 * Sanitize project name: lowercase, alphanumeric + hyphens only
 * @returns sanitized name or null if invalid
 */
export function sanitizeProjectName(name: string): string | null {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

/** Load project state from disk (lazy, once) */
function ensureStateLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;

  if (existsSync(STATE_PATH)) {
    try {
      const data = JSON.parse(
        readFileSync(STATE_PATH, "utf-8"),
      ) as ProjectState;
      activeProject = data.activeProject ?? null;
    } catch {
      activeProject = null;
    }
  }

  // Sync the home override with whatever we loaded
  syncHomeOverride();
}

/** Keep setProjectHomeOverride in sync with activeProject */
function syncHomeOverride(): void {
  if (activeProject) {
    setProjectHomeOverride(getProjectHome(activeProject));
  } else {
    setProjectHomeOverride(null);
  }
}

/** Persist project state to disk */
function persistState(): void {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
  }
  const state: ProjectState = { activeProject };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Get the currently active project name
 * @returns project name or null if global
 */
export function getActiveProject(): string | null {
  ensureStateLoaded();
  return activeProject;
}

/**
 * Get the home path for a specific project
 * @returns path to ~/.klausbot/projects/<name>/
 */
export function getProjectHome(projectName: string): string {
  return join(PROJECTS_DIR, projectName);
}

/**
 * Initialize directory structure for a project
 * Creates the project folder and all standard subdirectories
 */
export function initializeProjectDirs(projectName: string): void {
  const projectHome = getProjectHome(projectName);
  if (!existsSync(projectHome)) {
    mkdirSync(projectHome, { recursive: true });
  }
  for (const dir of DIRS) {
    // Skip config — config stays global
    if (dir === "config") continue;
    const dirPath = join(projectHome, dir);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }
  // Also create tasks subdirectories
  for (const sub of ["tasks/active", "tasks/completed", "tasks/notified"]) {
    const subPath = join(projectHome, sub);
    if (!existsSync(subPath)) {
      mkdirSync(subPath, { recursive: true });
    }
  }
}

/**
 * Set the active project (or null for global)
 *
 * IMPORTANT: Callers must handle DB switching separately via switchDb()
 * and identity cache invalidation via invalidateIdentityCache()
 *
 * @param projectName - project name or null to deselect
 * @returns true if project was set, false if name is invalid
 */
export function setActiveProject(projectName: string | null): boolean {
  ensureStateLoaded();

  if (projectName === null) {
    activeProject = null;
    syncHomeOverride();
    persistState();
    return true;
  }

  const sanitized = sanitizeProjectName(projectName);
  if (!sanitized) return false;

  // Create project directories if new
  initializeProjectDirs(sanitized);

  activeProject = sanitized;
  syncHomeOverride();
  persistState();
  return true;
}

/**
 * List all available projects
 * @returns array of project names (directory names under ~/.klausbot/projects/)
 */
export function listProjects(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];

  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Check if a project exists (has a directory)
 */
export function projectExists(projectName: string): boolean {
  const sanitized = sanitizeProjectName(projectName);
  if (!sanitized) return false;
  return existsSync(getProjectHome(sanitized));
}

/**
 * Reset in-memory state (for testing)
 */
export function resetProjectState(): void {
  activeProject = null;
  stateLoaded = false;
  setProjectHomeOverride(null);
}

/**
 * Force-load state from disk (for testing / hot-reload)
 */
export function reloadProjectState(): void {
  stateLoaded = false;
  ensureStateLoaded();
}
