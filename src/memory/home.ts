import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Logger } from "pino";

/** Base directory for all klausbot data */
export const KLAUSBOT_HOME = join(homedir(), ".klausbot");

/** Subdirectories to create under KLAUSBOT_HOME */
export const DIRS = ["config", "identity", "cron", "images", "logs"] as const;

/**
 * Segments that stay in the global KLAUSBOT_HOME even when a project is active.
 * Config and pairing are shared across all projects.
 */
const GLOBAL_SEGMENTS = new Set(["config"]);

/**
 * Active project home override — set by project.ts when a project is activated.
 * null means global (default ~/.klausbot/).
 */
let projectHomeOverride: string | null = null;

/**
 * Set the project home override path.
 * Called by project.ts — not meant for direct use elsewhere.
 * @param projectHome - full path to project directory, or null for global
 */
export function setProjectHomeOverride(projectHome: string | null): void {
  projectHomeOverride = projectHome;
}

/**
 * Get the current project home override (for testing/inspection).
 */
export function getProjectHomeOverride(): string | null {
  return projectHomeOverride;
}

/**
 * Initialize the klausbot home directory structure
 * Creates ~/.klausbot/ and all subdirectories if missing
 *
 * @param logger - Pino logger for initialization messages
 */
export function initializeHome(logger: Logger): void {
  // Create base directory
  if (!existsSync(KLAUSBOT_HOME)) {
    mkdirSync(KLAUSBOT_HOME, { recursive: true });
    logger.info({ path: KLAUSBOT_HOME }, "Created klausbot home directory");
  }

  // Create subdirectories
  for (const dir of DIRS) {
    const path = join(KLAUSBOT_HOME, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      logger.info({ path }, "Created directory");
    }
  }
}

/**
 * Get a path within the klausbot home directory
 *
 * When a project is active (via setProjectHomeOverride), most paths resolve to
 * the project directory instead of ~/.klausbot/
 *
 * Global paths (config/) always resolve to ~/.klausbot/ regardless of project.
 *
 * @param segments - Path segments to join with home directory
 * @returns Full path to the requested location
 */
export function getHomePath(...segments: string[]): string {
  // If no project override, or the first segment is global, use KLAUSBOT_HOME
  if (
    !projectHomeOverride ||
    (segments.length > 0 && GLOBAL_SEGMENTS.has(segments[0]))
  ) {
    return join(KLAUSBOT_HOME, ...segments);
  }

  return join(projectHomeOverride, ...segments);
}
