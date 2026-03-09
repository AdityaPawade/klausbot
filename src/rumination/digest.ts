/**
 * Digest log management — global storage for rumination digests.
 * Persists digests to ~/.klausbot/identity/DIGEST_LOG.md (always global, never per-project).
 * Handles append, read-recent, and trim operations.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { KLAUSBOT_HOME } from "../memory/home.js";

/** Separator between digest entries */
const ENTRY_SEPARATOR = "\n---\n";

/** Header pattern for digest entries: ## YYYY-MM-DD HH:MM UTC */
const ENTRY_HEADER_RE = /^## (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} UTC$/;

/**
 * Get path to the global digest log file.
 * Always resolves to ~/.klausbot/identity/ regardless of active project.
 */
export function getDigestLogPath(): string {
  return join(KLAUSBOT_HOME, "identity", "DIGEST_LOG.md");
}

/**
 * Get path to a pending digest awaiting delivery.
 * Written when the user is active; delivered on next idle window.
 */
export function getPendingDigestPath(): string {
  return join(KLAUSBOT_HOME, "identity", "PENDING_DIGEST.md");
}

/**
 * Read recent digest entries (within maxDays).
 * Returns raw text of recent entries for dedup context.
 */
export function readRecentDigests(maxDays: number = 30): string {
  const logPath = getDigestLogPath();
  if (!existsSync(logPath)) return "";

  const content = readFileSync(logPath, "utf-8").trim();
  if (!content) return "";

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);

  const entries = content.split(ENTRY_SEPARATOR);
  const recent: string[] = [];

  for (const entry of entries) {
    const firstLine = entry.trim().split("\n")[0];
    const match = firstLine?.match(ENTRY_HEADER_RE);
    if (match) {
      const entryDate = new Date(match[1]);
      if (entryDate >= cutoff) {
        recent.push(entry.trim());
      }
    }
  }

  return recent.join(ENTRY_SEPARATOR);
}

/**
 * Append a new digest entry with timestamp header.
 */
export function appendDigest(digest: string): void {
  const logPath = getDigestLogPath();
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toISOString().slice(11, 16);
  const header = `## ${dateStr} ${timeStr} UTC`;

  const entry = `${header}\n\n${digest.trim()}`;

  let content = "";
  if (existsSync(logPath)) {
    content = readFileSync(logPath, "utf-8").trim();
  }

  // Prepend new entry (newest first)
  const updated = content ? `${entry}${ENTRY_SEPARATOR}${content}` : entry;
  writeFileSync(logPath, updated + "\n");
}

/**
 * Trim digest log to keep only entries within maxDays.
 */
export function trimDigestLog(maxDays: number = 30): void {
  const logPath = getDigestLogPath();
  if (!existsSync(logPath)) return;

  const content = readFileSync(logPath, "utf-8").trim();
  if (!content) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);

  const entries = content.split(ENTRY_SEPARATOR);
  const kept: string[] = [];

  for (const entry of entries) {
    const firstLine = entry.trim().split("\n")[0];
    const match = firstLine?.match(ENTRY_HEADER_RE);
    if (match) {
      const entryDate = new Date(match[1]);
      if (entryDate >= cutoff) {
        kept.push(entry.trim());
      }
    }
  }

  writeFileSync(logPath, kept.join(ENTRY_SEPARATOR) + "\n");
}

/**
 * Write a pending digest for deferred delivery.
 */
export function writePendingDigest(digest: string): void {
  writeFileSync(getPendingDigestPath(), digest);
}

/**
 * Read and clear the pending digest (if any).
 * Returns null if no pending digest exists.
 */
export function consumePendingDigest(): string | null {
  const pendingPath = getPendingDigestPath();
  if (!existsSync(pendingPath)) return null;

  const content = readFileSync(pendingPath, "utf-8").trim();
  if (!content) return null;

  // Remove the pending file
  try {
    unlinkSync(pendingPath);
  } catch {
    // Ignore removal errors
  }

  return content;
}
