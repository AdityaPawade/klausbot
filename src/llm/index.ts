/**
 * LLM backend factory + public types.
 *
 * Single entry point — gateway/streaming/etc. import from "../llm/index.js"
 * and never reach into specific backend modules.
 */

import { ClaudeCodeBackend } from "./claude-code-backend.js";
import { OllamaBackend } from "./ollama-backend.js";
import type { LLMBackend } from "./types.js";
import type { JsonConfig } from "../config/schema.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("llm-factory");

let cachedBackend: LLMBackend | null = null;
let cachedBackendId: string | null = null;

/**
 * Build the LLMBackend based on klausbot's JSON config.
 * Cached — subsequent calls with the same config return the same instance.
 */
export function getBackend(config: JsonConfig): LLMBackend {
  const id = config.backend ?? "claude-code";
  if (cachedBackend && cachedBackendId === id) {
    return cachedBackend;
  }

  // Dispose of previous backend (different id requested)
  if (cachedBackend && cachedBackend.dispose) {
    void cachedBackend.dispose();
  }

  log.info({ backend: id }, "Initializing LLM backend");

  let backend: LLMBackend;
  switch (id) {
    case "claude-code":
      backend = new ClaudeCodeBackend();
      break;
    case "ollama": {
      const ollamaCfg = config.backendConfig?.ollama;
      if (!ollamaCfg?.model) {
        throw new Error(
          "Ollama backend requires backendConfig.ollama.model in klausbot.json",
        );
      }
      backend = new OllamaBackend({
        baseUrl: ollamaCfg.baseUrl,
        model: ollamaCfg.model,
        maxToolIterations: ollamaCfg.maxToolIterations,
        contextTokens: ollamaCfg.contextTokens,
      });
      break;
    }
    default:
      throw new Error(`Unknown backend: ${id}`);
  }

  cachedBackend = backend;
  cachedBackendId = id;
  return backend;
}

/** Force the next getBackend() call to rebuild — used after config reload */
export function resetBackend(): void {
  if (cachedBackend && cachedBackend.dispose) {
    void cachedBackend.dispose();
  }
  cachedBackend = null;
  cachedBackendId = null;
}

export { ClaudeCodeBackend } from "./claude-code-backend.js";
export { OllamaBackend } from "./ollama-backend.js";
export { McpBridge } from "./mcp-bridge.js";
export type {
  LLMBackend,
  BackendOptions,
  BackendResponse,
  BackendStreamOptions,
  BackendStreamResult,
  BackendRescueHandle,
  ToolUseEntry,
} from "./types.js";
