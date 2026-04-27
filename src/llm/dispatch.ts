/**
 * Top-level dispatchers for code that wants to call "the configured LLM".
 *
 * Every gateway/streaming/executor call site should go through dispatchQuery
 * or dispatchStream rather than reaching into a specific backend module.
 *
 * Lazy imports: backend modules are loaded on-demand so that just importing
 * this dispatcher doesn't pull in spawner.ts/streaming.ts at module init —
 * keeps the streaming.ts unit tests (which mock daemon/index.js) working.
 */

import { loadJsonConfig } from "../config/json.js";
import type {
  BackendOptions,
  BackendResponse,
  BackendStreamOptions,
  BackendStreamResult,
  LLMBackend,
} from "./types.js";

let cachedBackend: LLMBackend | null = null;
let cachedBackendId: string | null = null;

async function resolveBackend(): Promise<LLMBackend> {
  const config = loadJsonConfig();
  const id = config.backend ?? "claude-code";
  if (cachedBackend && cachedBackendId === id) {
    return cachedBackend;
  }

  // Dispose of previous backend
  if (cachedBackend?.dispose) {
    void cachedBackend.dispose();
  }

  let backend: LLMBackend;
  switch (id) {
    case "claude-code": {
      const { ClaudeCodeBackend } = await import("./claude-code-backend.js");
      backend = new ClaudeCodeBackend();
      break;
    }
    case "ollama": {
      const ollamaCfg = config.backendConfig?.ollama;
      if (!ollamaCfg?.model) {
        throw new Error(
          "Ollama backend requires backendConfig.ollama.model in klausbot.json",
        );
      }
      const { OllamaBackend } = await import("./ollama-backend.js");
      backend = new OllamaBackend({
        baseUrl: ollamaCfg.baseUrl,
        model: ollamaCfg.model,
        maxToolIterations: ollamaCfg.maxToolIterations,
        contextTokens: ollamaCfg.contextTokens,
        codeMode: ollamaCfg.codeMode,
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

export async function dispatchQuery(
  prompt: string,
  options: BackendOptions = {},
): Promise<BackendResponse> {
  const backend = await resolveBackend();
  return backend.query(prompt, options);
}

export async function dispatchStream(
  prompt: string,
  options: BackendStreamOptions,
  onChunk: (text: string) => void,
): Promise<BackendStreamResult> {
  const backend = await resolveBackend();
  return backend.stream(prompt, options, onChunk);
}

/** Get the active backend id without invoking it (for logging/diagnostics) */
export function getActiveBackendId(): string {
  const config = loadJsonConfig();
  return config.backend ?? "claude-code";
}

/** Force the next dispatch to rebuild the backend (config reload) */
export function resetBackend(): void {
  if (cachedBackend?.dispose) {
    void cachedBackend.dispose();
  }
  cachedBackend = null;
  cachedBackendId = null;
}
