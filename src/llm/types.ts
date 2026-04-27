/**
 * LLM Backend abstraction layer
 *
 * Defines the contract every LLM backend must satisfy so klausbot can
 * swap between Claude Code CLI, Ollama, OpenAI-compatible endpoints, etc.
 * without the gateway/streaming code knowing which backend is in use.
 *
 * Shape mirrors the existing ClaudeResponse/StreamResult so wrapping the
 * existing claude-code path requires zero behavior change.
 */

/** Tool use entry captured during a backend call */
export interface ToolUseEntry {
  name: string;
  input: Record<string, unknown>;
}

/** Backend response (batch path) — mirrors existing ClaudeResponse */
export interface BackendResponse {
  /** Final text response */
  result: string;
  /** Cost in USD (0 for local backends) */
  cost_usd: number;
  /** Backend-native session id (for resume) — may be empty for stateless backends */
  session_id: string;
  /** Wall clock duration in ms */
  duration_ms: number;
  /** Whether the backend reported an error */
  is_error: boolean;
  /** Tool uses performed during the call */
  toolUse?: ToolUseEntry[];
  /** Whether the response was resolved early via rescue */
  rescued?: boolean;
}

/** Handle for a rescued process — mirrors RescueHandle in spawner.ts */
export interface BackendRescueHandle {
  /** Get accumulated text at any point */
  getAccumulated: () => string;
  /** Resolves when the underlying call actually finishes (after rescue) */
  completion: Promise<BackendResponse>;
  /** Session id (may be empty until call completes) */
  sessionId: string;
  /** Get tool-use entries collected so far */
  toolUseSoFar: () => ToolUseEntry[];
  /** Kill the underlying call */
  kill: () => void;
}

/** Common options accepted by every backend */
export interface BackendOptions {
  /** Hard timeout in ms */
  timeout?: number;
  /** Model identifier (backend-specific syntax) */
  model?: string;
  /** Additional instructions appended to the system prompt (bootstrap mode) */
  additionalInstructions?: string;
  /** Telegram chat id — propagated for per-chat memory isolation */
  chatId?: number;
  /** Resolve early at this threshold (ms) with partial text; underlying call keeps running */
  rescueThresholdMs?: number;
  /** Called when rescue triggers — receives a handle to monitor the still-running call */
  onRescue?: (handle: BackendRescueHandle) => void;
  /** Inactivity timeout after first activity */
  inactivityTimeoutMs?: number;
  /** Backend session id to resume — opaque to gateway, interpreted by each backend */
  resumeSessionId?: string;
}

/** Streaming options — extends BackendOptions with abort/streaming-specific fields */
export interface BackendStreamOptions extends BackendOptions {
  signal?: AbortSignal;
}

/** Streaming result — mirrors existing StreamResult in streaming.ts */
export interface BackendStreamResult {
  result: string;
  cost_usd: number;
  session_id: string;
  toolUse?: ToolUseEntry[];
  /** Whether the streaming function already sent the message to Telegram */
  messageSent?: boolean;
  /** Whether the response was resolved early via rescue */
  rescued?: boolean;
}

/**
 * Generic LLM backend contract.
 *
 * Every backend must support both batch (query) and streaming (stream) call
 * shapes. Streaming reports text chunks via the onChunk callback so callers
 * can update Telegram messages live.
 */
export interface LLMBackend {
  /** Stable identifier for this backend ("claude-code", "ollama", ...) */
  readonly id: string;

  /** Health check — true if the backend is reachable / configured correctly */
  health(): Promise<{ ok: boolean; message?: string }>;

  /** Batch-style call — returns once the full response is built */
  query(prompt: string, options?: BackendOptions): Promise<BackendResponse>;

  /** Streaming call — onChunk fires for every text delta */
  stream(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<BackendStreamResult>;

  /** Lifecycle hook for resources that need explicit teardown (MCP clients etc.) */
  dispose?(): Promise<void>;
}

/** Factory output type — keep stable so consumer code doesn't change */
export type BackendFactory = () => LLMBackend;
