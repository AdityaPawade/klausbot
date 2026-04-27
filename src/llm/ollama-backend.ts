/**
 * OllamaBackend — uses a local Ollama server's chat API with MCP tools bridged
 * in via klausbot's existing MCP server.
 *
 * Architecture:
 *   1. On first use: spawn klausbot's MCP server, list its tools, convert
 *      schemas to OpenAI/Ollama function-calling shape.
 *   2. Per query: build messages array (load session if resuming), call
 *      Ollama /api/chat with tools, run any tool calls via the MCP bridge,
 *      append results, loop until model returns a final text answer.
 *   3. Save messages back to the session store so the next turn can resume.
 *
 * Streaming uses Ollama's stream=true endpoint. Tool calls are detected at
 * end-of-message; for those rounds, we don't stream chunks (Ollama emits
 * tool_calls only in the final message of a stream). Final assistant text
 * after tool round(s) IS streamed chunk-by-chunk.
 *
 * Notable design choices:
 * - We never use an external "ollama" npm package — plain fetch is simpler
 *   and adds zero new deps.
 * - "rescue" is implemented identically to the Claude path: a timer fires,
 *   the caller gets accumulated text + a handle to keep watching.
 * - Tool-call loop has a hard cap (default 8 rounds) to prevent runaways
 *   on confused small models.
 */

import { buildSystemPrompt } from "../memory/index.js";
import { createChildLogger } from "../utils/logger.js";
import { McpBridge } from "./mcp-bridge.js";
import {
  loadSession,
  newSessionId,
  saveSession,
  truncateToTokenBudget,
  type SessionMessage,
} from "./session-store.js";
import type {
  BackendOptions,
  BackendResponse,
  BackendRescueHandle,
  BackendStreamOptions,
  BackendStreamResult,
  LLMBackend,
  ToolUseEntry,
} from "./types.js";

const log = createChildLogger("ollama-backend");

/** Configuration for the Ollama backend */
export interface OllamaBackendConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Default model id (e.g. "qwen3:4b") */
  model: string;
  /** Max iterations of the tool-call loop per query (default: 8) */
  maxToolIterations?: number;
  /** Token budget for context truncation (default: 24000 — fits in 32k window with headroom) */
  contextTokens?: number;
}

/** Ollama /api/chat request shape (OpenAI-compatible-ish) */
interface OllamaChatRequest {
  model: string;
  messages: SessionMessage[];
  tools?: unknown[];
  stream?: boolean;
  options?: Record<string, unknown>;
  /** Keep model loaded in memory between requests (avoids cold start) */
  keep_alive?: string;
  /** Qwen3-specific: skip the chain-of-thought / "thinking" phase */
  think?: boolean;
}

/** One frame from Ollama streaming response */
interface OllamaStreamFrame {
  model?: string;
  created_at?: string;
  message?: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown> | string;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  eval_count?: number;
}

export class OllamaBackend implements LLMBackend {
  readonly id = "ollama";

  private bridge: McpBridge;
  private config: Required<OllamaBackendConfig>;

  constructor(config: OllamaBackendConfig) {
    this.config = {
      baseUrl: "http://localhost:11434",
      maxToolIterations: 8,
      contextTokens: 24000,
      ...config,
    };
    this.bridge = new McpBridge();
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`);
      if (!res.ok) {
        return { ok: false, message: `Ollama HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const found = data.models?.find((m) => m.name === this.config.model);
      if (!found) {
        return {
          ok: false,
          message: `Model ${this.config.model} not pulled. Run: ollama pull ${this.config.model}`,
        };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Ollama unreachable: ${msg}` };
    }
  }

  async query(
    prompt: string,
    options: BackendOptions = {},
  ): Promise<BackendResponse> {
    const start = Date.now();
    const result = await this.runAgent(prompt, options, /* onChunk */ () => {});
    return {
      result: result.result,
      cost_usd: 0,
      session_id: result.session_id,
      duration_ms: Date.now() - start,
      is_error: result.is_error,
      toolUse: result.toolUse,
      rescued: result.rescued,
    };
  }

  async stream(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<BackendStreamResult> {
    const start = Date.now();
    const result = await this.runAgent(prompt, options, onChunk);
    return {
      result: result.result,
      cost_usd: 0,
      session_id: result.session_id,
      toolUse: result.toolUse,
      rescued: result.rescued,
    };
    void start; // duration captured inside runAgent if needed
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose();
  }

  /** Core agent loop — shared by query() and stream() */
  private async runAgent(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<{
    result: string;
    session_id: string;
    is_error: boolean;
    toolUse?: ToolUseEntry[];
    rescued?: boolean;
  }> {
    await this.bridge.connect();
    const tools = await this.bridge.listTools();
    const model = options.model ?? this.config.model;

    // Determine session
    let sessionId: string;
    let messages: SessionMessage[];
    if (options.resumeSessionId) {
      const loaded = loadSession(options.resumeSessionId);
      if (loaded && loaded.length > 0) {
        sessionId = options.resumeSessionId;
        messages = loaded;
        log.info(
          { sessionId, prior: messages.length },
          "Resuming Ollama session",
        );
      } else {
        sessionId = options.resumeSessionId;
        messages = [
          { role: "system", content: this.buildSystemPromptText(options) },
        ];
        log.info({ sessionId }, "Resume requested but no prior session, starting fresh under that id");
      }
    } else {
      sessionId = newSessionId();
      messages = [
        { role: "system", content: this.buildSystemPromptText(options) },
      ];
      log.info({ sessionId }, "Starting fresh Ollama session");
    }

    // Wrap user prompt the same way the Claude path does (security + reminder)
    const wrappedPrompt = `<user_message>\n${prompt}\n</user_message>\n<reminder>You MUST include a conversational text response. If you performed any actions (file writes, memory updates, etc.), acknowledge them naturally. NEVER return empty.</reminder>`;
    messages.push({ role: "user", content: wrappedPrompt });

    // Truncate to budget BEFORE sending — older messages dropped, system kept
    messages = truncateToTokenBudget(messages, this.config.contextTokens);

    const toolUseEntries: ToolUseEntry[] = [];
    let accumulated = "";
    let rescued = false;
    let isError = false;

    // Rescue timer
    let rescueTimerId: ReturnType<typeof setTimeout> | null = null;
    let rescueResolved = false;
    const completionResolvers: Array<(r: BackendResponse) => void> = [];

    const armRescue = () => {
      if (!options.rescueThresholdMs || !options.onRescue) return;
      rescueTimerId = setTimeout(() => {
        if (rescueResolved) return;
        rescued = true;
        log.info(
          { accumulatedLength: accumulated.length, sessionId },
          "Ollama rescue threshold reached, surfacing partial",
        );
        const completion = new Promise<BackendResponse>((res) =>
          completionResolvers.push(res),
        );
        const handle: BackendRescueHandle = {
          getAccumulated: () => accumulated,
          completion,
          sessionId,
          toolUseSoFar: () => [...toolUseEntries],
          kill: () => {
            // No-op — Ollama HTTP requests can't really be force-killed externally
          },
        };
        options.onRescue!(handle);
      }, options.rescueThresholdMs);
    };
    armRescue();

    // Tool-call loop
    let iterations = 0;
    let finalText = "";
    while (iterations < this.config.maxToolIterations) {
      iterations += 1;

      const reply = await this.callOllama(
        {
          model,
          messages,
          tools,
          stream: true,
          keep_alive: "30m", // keep model loaded between requests
          options: {
            // Default Ollama context is 4096 — too small for klausbot's full
            // system prompt + tool schemas + history. Bump to fit.
            num_ctx: this.config.contextTokens,
            temperature: 0.3,
            // Qwen3 emits a multi-paragraph "thinking" block before its real
            // answer. On a Pi 5 CPU each thinking token is ~200ms, so we
            // disable it for tool-routing — we want fast user-visible output.
            // Harmless on non-Qwen models (option is ignored).
            num_predict: -1,
          },
          // Tell Qwen3 specifically to skip the thinking phase. Other models
          // ignore unknown body keys.
          think: false,
        },
        // Only stream chunks to caller AFTER all tool rounds are done.
        // For tool rounds, we're filling the messages array, not the user-visible text.
        iterations === 1 || messages[messages.length - 1].role === "tool"
          ? (chunk) => {
              accumulated += chunk;
              if (!rescued) onChunk(chunk);
            }
          : () => {},
        options.signal,
      );

      // Append assistant turn — normalize tool_calls.arguments to string for storage
      const assistantMsg: SessionMessage = {
        role: "assistant",
        content: reply.content,
        tool_calls: reply.tool_calls?.length
          ? reply.tool_calls.map((tc) => ({
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
              },
            }))
          : undefined,
      };
      messages.push(assistantMsg);

      if (reply.tool_calls && reply.tool_calls.length > 0) {
        // Execute each tool call sequentially; append each result
        for (const tc of reply.tool_calls) {
          const args =
            typeof tc.function.arguments === "string"
              ? safeParseJson(tc.function.arguments)
              : (tc.function.arguments as Record<string, unknown>);
          toolUseEntries.push({ name: tc.function.name, input: args });
          const text = await this.bridge.callTool(tc.function.name, args);
          messages.push({
            role: "tool",
            name: tc.function.name,
            content: text,
          });
        }
        // Loop again to let the model react to tool outputs
        continue;
      }

      // No tool calls — this is the final answer
      finalText = reply.content;
      break;
    }

    if (iterations >= this.config.maxToolIterations) {
      log.warn(
        { iterations, sessionId },
        "Ollama tool-call loop hit max iterations",
      );
      // Use whatever text we have
      finalText = finalText || accumulated || "[reached max tool iterations]";
      isError = true;
    }

    // Save session for next turn
    saveSession(sessionId, messages, {
      chatId: options.chatId,
      backend: this.id,
    });

    if (rescueTimerId) clearTimeout(rescueTimerId);
    rescueResolved = true;

    const final: BackendResponse = {
      result: finalText,
      cost_usd: 0,
      session_id: sessionId,
      duration_ms: 0,
      is_error: isError,
      toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
      rescued,
    };
    completionResolvers.forEach((r) => r(final));

    return {
      result: finalText,
      session_id: sessionId,
      is_error: isError,
      toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
      rescued,
    };
  }

  private buildSystemPromptText(options: BackendOptions): string {
    // Local Pi-class models cannot afford the full klausbot system prompt
    // (~30+ KB of identity files + retrieval/orchestration instructions).
    // Pre-fill prompt-eval time on a 4B model at ~10 tok/s would be 13+ min
    // BEFORE generating any response token.
    //
    // Strategy: extract just enough for the local model to act usefully
    // (basic identity + tool-calling guidance) and let MCP tool descriptions
    // carry the rest. Identity files are still consulted via the
    // search_memories tool when the user asks about themselves.
    const compact = [
      "You are klausbot, a Telegram personal assistant for Aditya.",
      "You speak warmly and concisely — replies are usually 1-3 sentences.",
      "When the user asks for an action you can do via a tool (schedule a cron, search memory, run a background task, look up a past conversation), CALL the tool with valid arguments.",
      "When the user just chats, reply naturally without calling any tool.",
      "If you call tools, ALWAYS produce a final conversational text reply after the tool result so the user sees something. Never return empty.",
    ].join(" ");

    let sys = compact;
    if (options.additionalInstructions) {
      sys += "\n\n" + options.additionalInstructions;
    }
    // Defensive cap — should never trigger for the compact prompt
    const maxSystemChars = Math.floor(this.config.contextTokens * 4 * 0.4);
    if (sys.length > maxSystemChars) {
      log.warn(
        { originalLen: sys.length, capped: maxSystemChars },
        "System prompt exceeds 40% of context budget, truncating for Ollama",
      );
      sys =
        sys.slice(0, maxSystemChars) +
        "\n\n[system prompt truncated to fit context]";
    }
    // Note: full identity buildSystemPrompt() is intentionally NOT used here.
    // To tune local-model behavior, edit `compact` above or surface more
    // context via MCP tool descriptions / search_memories.
    void buildSystemPrompt; // keep import live for type checking
    return sys;
  }

  /** Make a single /api/chat call, reading streamed frames */
  private async callOllama(
    req: OllamaChatRequest,
    onTextChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown> | string;
      };
    }>;
  }> {
    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let aggregated = "";
    let toolCalls:
      | Array<{
          function: {
            name: string;
            arguments: Record<string, unknown> | string;
          };
        }>
      | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const frame: OllamaStreamFrame = JSON.parse(line);
          const chunk = frame.message?.content ?? "";
          if (chunk) {
            aggregated += chunk;
            onTextChunk(chunk);
          }
          if (frame.message?.tool_calls && frame.message.tool_calls.length > 0) {
            toolCalls = frame.message.tool_calls;
          }
          if (frame.done) {
            return { content: aggregated, tool_calls: toolCalls };
          }
        } catch (err) {
          log.warn({ err, line: line.slice(0, 200) }, "Failed to parse Ollama stream line");
        }
      }
    }

    return { content: aggregated, tool_calls: toolCalls };
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}
