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
import { McpBridge, type OllamaTool } from "./mcp-bridge.js";
import {
  CODE_MODE_TOOL,
  buildCodeModeApiDoc,
  executeJsSandboxed,
  formatExecuteJsResult,
} from "./code-mode.js";
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

/** Configuration for the Ollama / llama-server backend */
export interface OllamaBackendConfig {
  /** Engine base URL (Ollama default: http://localhost:11434, llama-server default: http://localhost:8080) */
  baseUrl?: string;
  /** Default model id — for Ollama use "qwen3:4b", for llama-server use any string (it serves the loaded model) */
  model: string;
  /** Max iterations of the tool-call loop per query (default: 8) */
  maxToolIterations?: number;
  /** Token budget for context truncation (default: 24000 — fits in 32k window with headroom) */
  contextTokens?: number;
  /**
   * Use Code Mode (Cloudflare-style): expose a single `executeJs` tool that
   * runs JS calling `tools.<name>(...)` instead of N separate tool schemas.
   * Massively reduces token use and improves reliability on small models.
   */
  codeMode?: boolean;
  /**
   * Which inference engine API to speak. Both Ollama and llama-server accept
   * OpenAI-compatible /v1/chat/completions, so use that for a single code path.
   * "ollama" uses Ollama-only /api/chat (lets us pass keep_alive, num_ctx, think).
   * Default: "openai" (compatible with Ollama, llama-server, vLLM, LM Studio).
   */
  engineApi?: "ollama" | "openai";
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
  /** Cached typed-API doc string for Code Mode (built once per process) */
  private _codeModeApiDoc: string | null = null;

  constructor(config: OllamaBackendConfig) {
    this.config = {
      baseUrl: "http://localhost:11434",
      maxToolIterations: 8,
      contextTokens: 24000,
      codeMode: false,
      engineApi: "openai",
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
      rescued: false,
    };
  }

  async stream(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<BackendStreamResult> {
    const result = await this.runAgent(prompt, options, onChunk);
    return {
      result: result.result,
      cost_usd: 0,
      session_id: result.session_id,
      toolUse: result.toolUse,
      rescued: false,
    };
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
    const allMcpTools = await this.bridge.listTools();
    const model = options.model ?? this.config.model;
    // In Code Mode, the model only sees one tool (executeJs) but can call any
    // MCP tool from inside the sandbox. The MCP tools list is hidden but used
    // to build the system-prompt API documentation and to route calls.
    const tools = this.config.codeMode ? [CODE_MODE_TOOL] : allMcpTools;
    if (this.config.codeMode && !this._codeModeApiDoc) {
      this._codeModeApiDoc = buildCodeModeApiDoc(allMcpTools);
    }

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
    let isError = false;

    // Rescue mechanism is intentionally NOT implemented for the Ollama path.
    //
    // The Claude Code rescue model is: "the spawn keeps running in the
    // background; surface partial text now and follow up later." That works
    // because the Claude CLI is a long-lived child process that can be
    // monitored independently.
    //
    // Ollama is a single HTTP/2 streaming call. We cannot return partial
    // and continue — there's no second "channel" for the rest. Surfacing
    // a partial would require either canceling the stream (losing the
    // remainder) or echoing it twice.
    //
    // Net effect: ollama responses just take as long as they take. The
    // safetyTimeoutMs from config is still respected via the AbortSignal
    // wired through callOllama.
    void options.rescueThresholdMs;
    void options.onRescue;

    // Tool-call loop
    let iterations = 0;
    let finalText = "";
    while (iterations < this.config.maxToolIterations) {
      iterations += 1;
      const totalMessageChars = messages.reduce(
        (n, m) => n + m.content.length,
        0,
      );
      const toolSchemaChars = JSON.stringify(tools).length;
      log.info(
        {
          iteration: iterations,
          messages: messages.length,
          messagesChars: totalMessageChars,
          toolSchemaChars,
          model,
          ctx: this.config.contextTokens,
        },
        "Calling Ollama",
      );

      const reply = await this.callEngine(
        model,
        messages,
        tools,
        // Only stream chunks to caller AFTER all tool rounds are done.
        // For tool rounds, we're filling the messages array, not the user-visible text.
        iterations === 1 || messages[messages.length - 1].role === "tool"
          ? (chunk) => {
              accumulated += chunk;
              onChunk(chunk);
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

          let text: string;
          if (
            this.config.codeMode &&
            tc.function.name === CODE_MODE_TOOL.function.name
          ) {
            // Code Mode: run the JS in our sandbox, route inner tool calls to MCP
            const code = (args.code as string) ?? "";
            log.info(
              { codePreview: code.slice(0, 200) },
              "Executing code-mode JS",
            );
            const result = await executeJsSandboxed(
              code,
              this.bridge,
              allMcpTools,
            );
            text = formatExecuteJsResult(result);
          } else {
            text = await this.bridge.callTool(tc.function.name, args);
          }

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
      finalText = stripThinkingBlocks(reply.content);
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

    return {
      result: finalText,
      session_id: sessionId,
      is_error: isError,
      toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
      rescued: false, // Ollama path does not surface partials — see comment above
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
      this.config.codeMode
        ? "When the user asks for an action a tool can perform, CALL `executeJs` with code that uses the `tools` API documented below. Do not try to emit raw tool-call JSON — only `executeJs` exists."
        : "When the user asks for an action you can do via a tool (schedule a cron, search memory, run a background task, look up a past conversation), CALL the tool with valid arguments.",
      "When the user just chats, reply naturally without calling any tool.",
      "If you call tools, ALWAYS produce a final conversational text reply after the tool result so the user sees something. Never return empty.",
    ].join(" ");

    let sys = compact;
    // In Code Mode, append the typed-API documentation so the model knows
    // what's available inside `executeJs`.
    if (this.config.codeMode) {
      // We need the actual MCP tool list here, which buildSystemPromptText
      // doesn't have. Stash it on the instance temporarily.
      if (this._codeModeApiDoc) {
        sys += "\n\n" + this._codeModeApiDoc;
      }
    }
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

  /**
   * Make a chat request to whichever engine we're configured for.
   * Speaks Ollama /api/chat or OpenAI /v1/chat/completions depending on
   * config.engineApi. Both formats can return tool_calls.
   *
   * Non-streaming for OpenAI (simpler, llama-server returns one JSON).
   * Streaming for Ollama (better keep-alive support, only relevant for
   * the legacy code path).
   */
  private async callEngine(
    model: string,
    messages: SessionMessage[],
    tools: unknown[],
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
    if (this.config.engineApi === "openai") {
      return this.callOpenAI(model, messages, tools, onTextChunk, signal);
    }
    return this.callOllama(model, messages, tools, onTextChunk, signal);
  }

  /** OpenAI-compatible /v1/chat/completions — works on Ollama, llama-server, vLLM, LM Studio */
  private async callOpenAI(
    model: string,
    messages: SessionMessage[],
    tools: unknown[],
    onTextChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> | string };
    }>;
  }> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls
          ? {
              tool_calls: m.tool_calls.map((tc, i) => ({
                id: tc.id ?? `call_${i}`,
                type: "function",
                function: tc.function,
              })),
            }
          : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      stream: false,
      max_tokens: 1024,
      temperature: 0.3,
      // Tell qwen3 to skip thinking. Llama-server's chat-template macro reads
      // chat_template_kwargs; ignored by other engines. Saves real time on Pi.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (tools && (tools as unknown[]).length > 0) body.tools = tools;

    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function: {
              name: string;
              arguments: string | Record<string, unknown>;
            };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const msg = data.choices?.[0]?.message;
    const content = msg?.content ?? "";
    if (content) onTextChunk(content);
    log.info(
      {
        prompt_tokens: data.usage?.prompt_tokens,
        completion_tokens: data.usage?.completion_tokens,
        cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens,
        finish_reason: data.choices?.[0]?.finish_reason,
        toolCalls: msg?.tool_calls?.length ?? 0,
      },
      "OpenAI-style response",
    );
    return {
      content,
      tool_calls: msg?.tool_calls?.map((tc) => ({
        function: tc.function,
      })),
    };
  }

  /** Native Ollama /api/chat with streaming — preserved for engineApi="ollama" */
  private async callOllama(
    model: string,
    messages: SessionMessage[],
    tools: unknown[],
    onTextChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> | string };
    }>;
  }> {
    const req: OllamaChatRequest = {
      model,
      messages,
      tools,
      stream: true,
      keep_alive: "30m",
      options: {
        num_ctx: this.config.contextTokens,
        temperature: 0.3,
        num_predict: -1,
      },
      think: false,
    };
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

    let frameCount = 0;
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
          frameCount += 1;
          if (frameCount === 1) {
            log.info(
              { firstFrame: line.slice(0, 200) },
              "First Ollama stream frame received",
            );
          }
          const chunk = frame.message?.content ?? "";
          if (chunk) {
            aggregated += chunk;
            onTextChunk(chunk);
          }
          if (frame.message?.tool_calls && frame.message.tool_calls.length > 0) {
            toolCalls = frame.message.tool_calls;
            log.info(
              { tools: frame.message.tool_calls.map((c) => c.function.name) },
              "Tool calls in stream frame",
            );
          }
          if (frame.done) {
            log.info(
              {
                frames: frameCount,
                aggregatedLen: aggregated.length,
                toolCalls: toolCalls?.length ?? 0,
                done_reason: (frame as { done_reason?: string }).done_reason,
                eval_count: (frame as { eval_count?: number }).eval_count,
                total_duration_ms:
                  (frame as { total_duration?: number }).total_duration ??
                  0 / 1e6,
              },
              "Ollama stream complete",
            );
            return { content: aggregated, tool_calls: toolCalls };
          }
        } catch (err) {
          log.warn({ err, line: line.slice(0, 200) }, "Failed to parse Ollama stream line");
        }
      }
    }

    log.warn(
      { frames: frameCount, aggregatedLen: aggregated.length },
      "Ollama stream ended without 'done' frame",
    );
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

/**
 * Strip Qwen3-style chain-of-thought "thinking" blocks from a response.
 *
 * Qwen3 emits internal reasoning between <think> and </think> tags. The
 * `think:false` request flag is supposed to suppress this but doesn't
 * always work in streaming mode (Ollama renders the thinking content as
 * regular content frames). Without filtering, the user sees several
 * paragraphs of stream-of-consciousness BEFORE the actual reply.
 *
 * Behavior:
 * - If a closing </think> tag is present, drop everything up to and
 *   including the LAST occurrence — works whether or not the opening
 *   <think> tag is present.
 * - If no </think> tag, return content unchanged.
 * - Trim leading/trailing whitespace from the final result.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text;
  const closeIdx = text.lastIndexOf("</think>");
  if (closeIdx >= 0) {
    return text.slice(closeIdx + "</think>".length).trim();
  }
  // Some models emit just `<think>...</think>` inline-deletable
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
