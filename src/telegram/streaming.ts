import { spawn } from "child_process";
import { createInterface } from "readline";
import { Bot } from "grammy";
import { createChildLogger } from "../utils/index.js";
import { markdownToTelegramHtml } from "../utils/index.js";
import { KLAUSBOT_HOME, buildSystemPrompt } from "../memory/index.js";
import {
  writeMcpConfigFile,
  getHooksConfig,
  type ToolUseEntry,
} from "../daemon/index.js";

const log = createChildLogger("streaming");

/** Default timeout for streaming (300s — streaming provides live feedback via editMessageText) */
const DEFAULT_TIMEOUT = 300_000;

/** Streaming configuration matching jsonConfigSchema */
export interface StreamConfig {
  enabled: boolean;
  throttleMs: number;
}

/** NDJSON event from Claude CLI stream-json output */
interface StreamEvent {
  type: string;
  delta?: { text?: string; type?: string; partial_json?: string };
  content_block?: { type?: string; name?: string };
  /** Present in "assistant" message events — contains tool_use blocks for MCP calls */
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  result?: string; // Present in final "result" event
  cost_usd?: number; // Present in final "result" event (older CLI versions)
  total_cost_usd?: number; // Present in final "result" event (CLI v2.1+)
  session_id?: string; // Present in final "result" event
  is_error?: boolean; // Present in final "result" event
}

/** Options for streaming Claude response */
export interface StreamOptions {
  model?: string;
  additionalInstructions?: string;
  signal?: AbortSignal;
  /** Telegram chat ID — propagated to hooks/MCP for per-chat memory isolation */
  chatId?: number;
}

/** Result from streaming Claude response */
export interface StreamResult {
  result: string;
  cost_usd: number;
  /** Session ID for --resume */
  session_id: string;
  /** Tool uses performed during the session */
  toolUse?: ToolUseEntry[];
  /** Whether the streaming function already sent the message to Telegram */
  messageSent?: boolean;
}

/**
 * Stream Claude response with callback for each text chunk.
 * Uses callback pattern (not generator) so caller can access return value.
 *
 * @param prompt - User message
 * @param options - Model, additional instructions, abort signal
 * @param onChunk - Called with each text delta as it arrives
 * @returns Promise with final result and cost
 */
export async function streamClaudeResponse(
  prompt: string,
  options: StreamOptions,
  onChunk: (text: string) => void,
): Promise<StreamResult> {
  // Build system prompt from identity files (same as spawner.ts)
  let systemPrompt = buildSystemPrompt();

  // Append additional instructions if provided
  if (options.additionalInstructions) {
    systemPrompt += "\n\n" + options.additionalInstructions;
  }

  // Guard against E2BIG: Linux MAX_ARG_STRLEN is 128KB per argument.
  // Truncate if the system prompt exceeds 120KB (leaving 8KB margin).
  const MAX_SYSTEM_PROMPT_BYTES = 120_000;
  const promptBytes = Buffer.byteLength(systemPrompt, "utf-8");
  if (promptBytes > MAX_SYSTEM_PROMPT_BYTES) {
    log.warn(
      { promptBytes, limit: MAX_SYSTEM_PROMPT_BYTES },
      "System prompt exceeds size limit, truncating",
    );
    systemPrompt = systemPrompt.slice(0, MAX_SYSTEM_PROMPT_BYTES);
  }

  // Wrap prompt in XML tags for security (same as spawner.ts)
  // Reminder ensures text output even when tool-use occurs
  const wrappedPrompt = `<user_message>\n${prompt}\n</user_message>\n<reminder>You MUST include a conversational text response. If you performed any actions (file writes, memory updates, etc.), acknowledge them naturally. NEVER return empty.</reminder>`;

  // Write MCP config and hooks settings (same as batch path)
  const mcpConfigPath = writeMcpConfigFile();
  const settingsJson = JSON.stringify(getHooksConfig());

  const args = [
    "--dangerously-skip-permissions",
    "-p",
    wrappedPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    systemPrompt,
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsJson,
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  // Block Task tool — background work uses --resume via daemon
  args.push("--disallowedTools", "Task,TaskOutput");

  return new Promise((resolve, reject) => {
    // Build environment with chat ID
    const env = { ...process.env };
    if (options.chatId !== undefined) {
      env.KLAUSBOT_CHAT_ID = String(options.chatId);
    }

    // CRITICAL: stdin must inherit to avoid hang bug (same as spawner.ts)
    const claude = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: KLAUSBOT_HOME,
      env,
    });

    let accumulated = "";
    let costUsd = 0;
    let sessionId = "";
    let timedOut = false;

    // Tool-use tracking
    const toolUseEntries: ToolUseEntry[] = [];
    let currentToolName = "";
    let currentToolInput = "";

    // Set up timeout (90s — fast dispatcher limit)
    const timeoutId = setTimeout(() => {
      timedOut = true;
      log.warn(
        { resultLength: accumulated.length },
        "Stream timed out, killing process",
      );
      claude.kill("SIGTERM");
      // Force kill if SIGTERM doesn't work after 5s
      setTimeout(() => {
        if (!claude.killed) {
          claude.kill("SIGKILL");
        }
      }, 5000);
    }, DEFAULT_TIMEOUT);

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        claude.kill("SIGTERM");
      });
    }

    const rl = createInterface({ input: claude.stdout! });

    rl.on("line", (line) => {
      try {
        const event: StreamEvent = JSON.parse(line);

        // Text delta events - call onChunk callback
        if (event.type === "content_block_delta" && event.delta?.text) {
          accumulated += event.delta.text;
          onChunk(event.delta.text);
        }

        // Tool use start — capture tool name
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          currentToolName = event.content_block.name ?? "";
          currentToolInput = "";
        }

        // Tool use input delta
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta"
        ) {
          currentToolInput += event.delta.partial_json ?? "";
        }

        // Tool use block end — save entry
        if (event.type === "content_block_stop" && currentToolName) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(currentToolInput);
          } catch {
            parsedInput = { _raw: currentToolInput };
          }
          toolUseEntries.push({ name: currentToolName, input: parsedInput });
          currentToolName = "";
          currentToolInput = "";
        }

        // MCP tool calls arrive as "assistant" message events with tool_use content blocks
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "tool_use" && block.name) {
              toolUseEntries.push({
                name: block.name,
                input: block.input ?? {},
              });
            }
          }
        }

        // Final "result" event contains metadata
        if (event.type === "result") {
          if (event.result !== undefined) {
            accumulated = event.result;
          }
          // CLI v2.1+ uses total_cost_usd, older versions use cost_usd
          if (event.total_cost_usd !== undefined) {
            costUsd = event.total_cost_usd;
          } else if (event.cost_usd !== undefined) {
            costUsd = event.cost_usd;
          }
          if (event.session_id !== undefined) {
            sessionId = event.session_id;
          }
        }
      } catch {
        // Skip non-JSON lines (stderr leakage, etc.)
      }
    });

    rl.on("close", () => {
      clearTimeout(timeoutId);

      const toolUse = toolUseEntries.length > 0 ? toolUseEntries : undefined;

      if (timedOut) {
        const timeoutNotice =
          "\n\n[Response timed out — if a background task was started, you'll still be notified when it completes]";
        const result = accumulated + timeoutNotice;
        log.warn(
          { resultLength: accumulated.length },
          "Stream timed out, returning partial result with notice",
        );
        resolve({ result, cost_usd: 0, session_id: sessionId, toolUse });
      } else {
        log.info(
          {
            resultLength: accumulated.length,
            cost_usd: costUsd,
            session_id: sessionId,
            toolUseCount: toolUseEntries.length,
          },
          "Stream completed",
        );
        resolve({
          result: accumulated,
          cost_usd: costUsd,
          session_id: sessionId,
          toolUse,
        });
      }
    });

    claude.on("error", (err) => {
      clearTimeout(timeoutId);
      log.error({ err }, "Stream spawn error");
      reject(err);
    });

    claude.stderr!.on("data", (data: Buffer) => {
      log.warn({ stderr: data.toString().slice(0, 200) }, "Stream stderr");
    });
  });
}

/**
 * Check if chat supports streaming.
 * Enabled for private chats and supergroups (topic groups).
 */
export async function canStreamToChat(
  bot: Bot<any>,
  chatId: number,
): Promise<boolean> {
  try {
    const chat = await bot.api.getChat(chatId);
    return chat.type === "private" || chat.type === "supergroup";
  } catch {
    return false;
  }
}

/** Max chars for a single Telegram message — leave margin below 4096 for cursor + parse overhead */
const EDIT_CHAR_LIMIT = 4000;

/** Options for streaming to Telegram */
export interface StreamToTelegramOptions {
  model?: string;
  additionalInstructions?: string;
  messageThreadId?: number;
  /** Telegram chat ID — propagated for per-chat memory isolation */
  chatId?: number;
  /** Reply to this message ID (first chunk) */
  replyToMessageId?: number;
}

/**
 * Stream Claude response to Telegram via sendMessage + editMessageText.
 * First text chunk sends a real message, subsequent chunks edit it with a ▌ cursor.
 * Final edit removes the cursor and sets the full formatted response.
 *
 * If accumulated text exceeds ~4000 chars during streaming, editing stops.
 * The caller should use splitAndSend() for the final text in that case.
 *
 * @param bot - grammY Bot instance
 * @param chatId - Telegram chat ID
 * @param prompt - User message to send to Claude
 * @param config - Streaming configuration (throttleMs)
 * @param options - Optional model, instructions, thread ID
 * @returns Final result text, cost, and whether message was already sent
 */
export async function streamToTelegram(
  bot: Bot<any>,
  chatId: number,
  prompt: string,
  config: StreamConfig,
  options?: StreamToTelegramOptions,
): Promise<StreamResult> {
  const controller = new AbortController();

  let accumulated = "";
  let sentMessageId: number | null = null;
  let lastUpdateTime = 0;
  let overflowed = false;

  // Callback for each text chunk — sends/edits real messages
  const onChunk = async (text: string): Promise<void> => {
    accumulated += text;

    // Stop editing once we exceed the safe limit
    if (accumulated.length > EDIT_CHAR_LIMIT) {
      overflowed = true;
      return;
    }

    const now = Date.now();

    if (!sentMessageId) {
      // First chunk: send a real message with cursor
      try {
        const msg = await bot.api.sendMessage(chatId, accumulated + " \u258C", {
          message_thread_id: options?.messageThreadId,
          reply_parameters: options?.replyToMessageId
            ? { message_id: options.replyToMessageId }
            : undefined,
        });
        sentMessageId = msg.message_id;
        lastUpdateTime = now;
      } catch (err) {
        log.warn({ err, chatId }, "Failed to send initial streaming message");
      }
    } else if (now - lastUpdateTime >= config.throttleMs) {
      // Subsequent chunks: edit existing message (throttled)
      try {
        await bot.api.editMessageText(
          chatId,
          sentMessageId,
          accumulated + " \u258C",
        );
        lastUpdateTime = now;
      } catch (err) {
        // Rate limit or network error — next cycle will retry
        log.debug({ err, chatId }, "Edit throttled or failed, continuing");
      }
    }
  };

  try {
    const result = await streamClaudeResponse(
      prompt,
      {
        model: options?.model,
        additionalInstructions: options?.additionalInstructions,
        signal: controller.signal,
        chatId: options?.chatId,
      },
      onChunk,
    );

    // Final edit: remove cursor, set full formatted text
    if (sentMessageId && !overflowed) {
      try {
        const finalHtml = markdownToTelegramHtml(result.result);
        // Only edit if text fits in a single message
        if (finalHtml.length <= 4096) {
          await bot.api.editMessageText(chatId, sentMessageId, finalHtml, {
            parse_mode: "HTML",
          });
          return { ...result, messageSent: true };
        }
      } catch (err) {
        log.warn({ err, chatId }, "Final edit failed, will splitAndSend");
      }
    }

    // If we sent a message but need to splitAndSend the final version,
    // delete the partial streaming message first
    if (sentMessageId) {
      try {
        await bot.api.deleteMessage(chatId, sentMessageId);
      } catch {
        // Best effort — message may already be gone
      }
    }

    // messageSent = false → caller should splitAndSend the full result
    return { ...result, messageSent: false };
  } catch (err) {
    controller.abort();

    // On error, still try to return accumulated partial result
    if (accumulated.length > 0) {
      log.error({ err, chatId }, "Stream error, returning partial result");
      return { result: accumulated, cost_usd: 0, session_id: "" };
    }

    throw err;
  }
}
