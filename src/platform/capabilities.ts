/**
 * Capability detection for klausbot.
 *
 * Defines required and optional capabilities with their check functions.
 * Used by startup checklist to show what features are available.
 */

import { execSync } from "child_process";
import { which } from "../utils/which.js";
import { isContainer } from "./detect.js";
import { loadJsonConfig } from "../config/json.js";

/** Capability severity level */
export type Severity = "required" | "optional";

/** Capability check status */
export type Status = "ok" | "missing";

/** Capability definition */
export interface Capability {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether capability is required or optional */
  severity: Severity;
  /** Check function - returns status */
  check: () => Promise<Status> | Status;
  /** Hint for remediation if missing */
  hint: string;
}

/** Result of checking a capability */
export interface CheckResult {
  /** The capability that was checked */
  capability: Capability;
  /** The status of the check */
  status: Status;
}

/**
 * All capabilities for klausbot.
 * Order: required first, then optional.
 */
export const capabilities: Capability[] = [
  {
    id: "telegram",
    name: "Telegram Bot Token",
    severity: "required",
    check: () => (process.env.TELEGRAM_BOT_TOKEN ? "ok" : "missing"),
    hint: "Set TELEGRAM_BOT_TOKEN in environment or ~/.klausbot/.env",
  },
  {
    id: "claude",
    name: "Claude Code",
    // Required only when the active backend is claude-code; optional for other backends
    severity: (() => {
      try {
        const cfg = loadJsonConfig();
        return cfg.backend === "claude-code" ? "required" : "optional";
      } catch {
        return "required";
      }
    })(),
    check: () => {
      // Check if claude is in PATH using Node APIs
      if (!which("claude")) return "missing";
      try {
        // Verify it responds
        execSync("claude --version", { stdio: "pipe", timeout: 5000 });
        return "ok";
      } catch {
        return "missing";
      }
    },
    hint: "Install Claude Code: https://claude.ai/code (or set backend != claude-code in klausbot.json)",
  },
  {
    id: "ollama",
    name: "Ollama (local LLM)",
    // Required only when the active backend is ollama
    severity: (() => {
      try {
        const cfg = loadJsonConfig();
        return cfg.backend === "ollama" ? "required" : "optional";
      } catch {
        return "optional";
      }
    })(),
    check: async () => {
      try {
        const cfg = loadJsonConfig();
        if (cfg.backend !== "ollama") return "ok";
        const url =
          cfg.backendConfig?.ollama?.baseUrl ?? "http://localhost:11434";
        const model = cfg.backendConfig?.ollama?.model;
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return "missing";
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        if (model && !data.models?.find((m) => m.name === model)) return "missing";
        return "ok";
      } catch {
        return "missing";
      }
    },
    hint: "Start Ollama (`ollama serve`) and pull the configured model",
  },
  {
    id: "container-oauth",
    name: "Container OAuth Token",
    severity: "required",
    check: () => {
      // Only required when running in a container
      if (!isContainer()) return "ok";
      return process.env.CLAUDE_CODE_OAUTH_TOKEN ? "ok" : "missing";
    },
    hint: "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in container env",
  },
  {
    id: "openai",
    name: "OpenAI API (search_memory)",
    severity: "optional",
    check: () => (process.env.OPENAI_API_KEY ? "ok" : "missing"),
    hint: "Set OPENAI_API_KEY for semantic memory search",
  },
];

/**
 * Check all capabilities and return results.
 *
 * @returns Array of CheckResult for each capability
 */
export async function checkAllCapabilities(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const capability of capabilities) {
    const status = await capability.check();
    results.push({ capability, status });
  }

  return results;
}
