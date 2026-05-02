/**
 * Session store for non-Claude-Code backends.
 *
 * Claude Code CLI persists sessions to ~/.claude/projects/ and uses --resume.
 * Local backends like Ollama have no built-in persistence, so we store the
 * conversation message array per session id in SQLite. Within a 30-min reuse
 * window, the same session id replays the full history; outside that window,
 * a fresh session starts.
 */

import { randomUUID } from "crypto";
import { getDb } from "../memory/db.js";
import type { Logger } from "pino";
import { createChildLogger } from "../utils/logger.js";

const log: Logger = createChildLogger("llm-session-store");

/** Single message in a conversation history (Ollama / OpenAI shape) */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For assistant messages with tool calls */
  tool_calls?: Array<{
    id?: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
  /** For role:"tool" — links back to the assistant's tool_call id */
  tool_call_id?: string;
  /** For role:"tool" — name of the tool that ran */
  name?: string;
}

let initialized = false;

function ensureSchema() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_sessions (
      session_id      TEXT PRIMARY KEY,
      chat_id         INTEGER,
      backend         TEXT NOT NULL,
      messages_json   TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_sessions_chat ON llm_sessions(chat_id);
    CREATE INDEX IF NOT EXISTS idx_llm_sessions_activity ON llm_sessions(last_activity_at);
  `);
  initialized = true;
}

export function newSessionId(): string {
  return randomUUID();
}

export function loadSession(sessionId: string): SessionMessage[] | null {
  ensureSchema();
  const db = getDb();
  const row = db
    .prepare("SELECT messages_json FROM llm_sessions WHERE session_id = ?")
    .get(sessionId) as { messages_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.messages_json) as SessionMessage[];
  } catch (err) {
    log.warn(
      { err, sessionId },
      "Failed to parse session messages, treating as fresh",
    );
    return null;
  }
}

export function saveSession(
  sessionId: string,
  messages: SessionMessage[],
  options: { chatId?: number; backend: string },
): void {
  ensureSchema();
  const db = getDb();
  const now = Date.now();
  const json = JSON.stringify(messages);
  // INSERT or REPLACE — preserves created_at if existing
  const existing = db
    .prepare("SELECT created_at FROM llm_sessions WHERE session_id = ?")
    .get(sessionId) as { created_at: number } | undefined;
  const createdAt = existing?.created_at ?? now;
  db.prepare(
    `INSERT OR REPLACE INTO llm_sessions
     (session_id, chat_id, backend, messages_json, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    options.chatId ?? null,
    options.backend,
    json,
    createdAt,
    now,
  );
}

export function deleteSession(sessionId: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare("DELETE FROM llm_sessions WHERE session_id = ?").run(sessionId);
}

/** Truncate messages array to fit a token budget (rough heuristic). */
export function truncateToTokenBudget(
  messages: SessionMessage[],
  maxTokens: number,
): SessionMessage[] {
  // Rough heuristic: 1 token ≈ 4 characters of mixed text/JSON
  const budgetChars = maxTokens * 4;
  // Always preserve the system message (index 0 if present)
  const keepSystem =
    messages.length > 0 && messages[0].role === "system" ? messages[0] : null;
  const rest = keepSystem ? messages.slice(1) : messages;

  let totalChars = keepSystem ? keepSystem.content.length : 0;
  const kept: SessionMessage[] = [];

  // Walk from the END (most recent) and keep messages until we run out of budget
  for (let i = rest.length - 1; i >= 0; i--) {
    const msgChars =
      rest[i].content.length + JSON.stringify(rest[i].tool_calls ?? "").length;
    if (totalChars + msgChars > budgetChars) break;
    kept.unshift(rest[i]);
    totalChars += msgChars;
  }

  return keepSystem ? [keepSystem, ...kept] : kept;
}
