import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("session-tracker");

/** Window (ms) within which we reuse a session — 30 minutes */
const SESSION_REUSE_WINDOW_MS = 30 * 60 * 1000;

interface ActiveSession {
  sessionId: string;
  lastActivity: number;
}

/** Per-chat session tracking for --resume continuity */
const activeSessions = new Map<number, ActiveSession>();

/**
 * Record a session ID for a chat after a successful Claude response.
 * Called after both batch and streaming paths complete.
 */
export function recordSession(chatId: number, sessionId: string): void {
  if (!sessionId || sessionId === "recovered") return;

  activeSessions.set(chatId, {
    sessionId,
    lastActivity: Date.now(),
  });

  log.debug({ chatId, sessionId }, "Session recorded for resume");
}

/**
 * Get a resumable session ID for a chat, if one exists within the time window.
 * Returns null if no active session or if it's stale.
 */
export function getResumableSession(chatId: number): string | null {
  const entry = activeSessions.get(chatId);
  if (!entry) return null;

  const age = Date.now() - entry.lastActivity;
  if (age > SESSION_REUSE_WINDOW_MS) {
    activeSessions.delete(chatId);
    log.debug(
      { chatId, ageMinutes: Math.round(age / 60000) },
      "Session expired, starting fresh",
    );
    return null;
  }

  log.debug(
    { chatId, sessionId: entry.sessionId, ageMinutes: Math.round(age / 60000) },
    "Resuming existing session",
  );
  return entry.sessionId;
}

/**
 * Clear tracked session for a chat (e.g., on error or explicit reset).
 */
export function clearSession(chatId: number): void {
  activeSessions.delete(chatId);
}

/**
 * Clear all tracked sessions (e.g., on shutdown).
 */
export function clearAllSessions(): void {
  activeSessions.clear();
}
