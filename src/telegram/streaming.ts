import { spawn } from "child_process";
import { createInterface } from "readline";
import { Bot } from "grammy";
import { createChildLogger } from "../utils/index.js";
import { KLAUSBOT_HOME, buildSystemPrompt } from "../memory/index.js";

const log = createChildLogger("streaming");

/** Default timeout for streaming (5 minutes, matches batch spawner) */
const DEFAULT_TIMEOUT = 300000;

/** Streaming configuration matching jsonConfigSchema */
export interface StreamConfig {
  enabled: boolean;
  throttleMs: number;
}

/** NDJSON event from Claude CLI stream-json output */
interface StreamEvent {
  type: string;
  delta?: { text?: string };
  result?: string; // Present in final "result" event
  cost_usd?: number; // Present in final "result" event
  session_id?: string; // Present in final "result" event
}

/** Options for streaming Claude response */
export interface StreamOptions {
  model?: string;
  additionalInstructions?: string;
  signal?: AbortSignal;
}

/** Result from streaming Claude response */
export interface StreamResult {
  result: string;
  cost_usd: number;
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

  // Wrap prompt in XML tags for security (same as spawner.ts)
  const wrappedPrompt = `<user_message>\n${prompt}\n</user_message>`;

  // Build args - note: no --mcp-config or --settings for streaming
  // (hooks don't make sense for streaming, MCP tools work differently)
  const args = [
    "--dangerously-skip-permissions",
    "-p",
    wrappedPrompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--append-system-prompt",
    systemPrompt,
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  return new Promise((resolve, reject) => {
    // CRITICAL: stdin must inherit to avoid hang bug (same as spawner.ts)
    const claude = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: KLAUSBOT_HOME,
      env: process.env,
    });

    let accumulated = "";
    let costUsd = 0;
    let sessionId = "";

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
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

        // Final "result" event contains metadata
        // Event type is "result" and has result, cost_usd, session_id fields
        if (event.type === "result") {
          if (event.result !== undefined) {
            accumulated = event.result; // Use final result (may differ from accumulated deltas)
          }
          if (event.cost_usd !== undefined) {
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
      log.info(
        {
          resultLength: accumulated.length,
          cost_usd: costUsd,
          session_id: sessionId,
        },
        "Stream completed",
      );
      resolve({ result: accumulated, cost_usd: costUsd });
    });

    claude.on("error", (err) => {
      log.error({ err }, "Stream spawn error");
      reject(err);
    });

    claude.stderr!.on("data", (data: Buffer) => {
      log.warn({ stderr: data.toString().slice(0, 200) }, "Stream stderr");
    });
  });
}

/**
 * Check if chat supports draft streaming.
 * Requires private chat with forum topics enabled (BotFather "Threaded Mode").
 */
export async function canStreamToChat(
  bot: Bot,
  chatId: number,
): Promise<boolean> {
  try {
    const chat = await bot.api.getChat(chatId);
    // Draft streaming requires private chat with topics enabled
    return chat.type === "private" && Boolean(chat.has_topics_enabled);
  } catch {
    return false;
  }
}

/** Draft ID counter for unique draft identification */
let draftIdCounter = 0;

/** Options for streaming to Telegram */
export interface StreamToTelegramOptions {
  model?: string;
  additionalInstructions?: string;
  messageThreadId?: number;
}

/**
 * Stream Claude response to Telegram via draft updates.
 * Shows user real-time response generation in a draft bubble.
 *
 * @param bot - grammY Bot instance
 * @param chatId - Telegram chat ID
 * @param prompt - User message to send to Claude
 * @param config - Streaming configuration (throttleMs)
 * @param options - Optional model, instructions, thread ID
 * @returns Final result text and cost
 */
export async function streamToTelegram(
  bot: Bot,
  chatId: number,
  prompt: string,
  config: StreamConfig,
  options?: StreamToTelegramOptions,
): Promise<{ result: string; cost_usd: number }> {
  const draftId = ++draftIdCounter;
  const controller = new AbortController();

  let accumulated = "";
  let lastUpdateTime = 0;

  // Callback for each text chunk - sends throttled draft updates
  const onChunk = async (text: string): Promise<void> => {
    accumulated += text;

    const now = Date.now();
    if (now - lastUpdateTime >= config.throttleMs) {
      try {
        await bot.api.sendMessageDraft(chatId, draftId, accumulated, {
          message_thread_id: options?.messageThreadId,
        });
        lastUpdateTime = now;
      } catch (err) {
        log.warn({ err, chatId }, "Draft update failed, continuing");
      }
    }
  };

  try {
    // Call streamClaudeResponse with callback
    const result = await streamClaudeResponse(
      prompt,
      {
        model: options?.model,
        additionalInstructions: options?.additionalInstructions,
        signal: controller.signal,
      },
      onChunk,
    );

    // Send final draft update (ensures latest content shown)
    await bot.api
      .sendMessageDraft(chatId, draftId, result.result, {
        message_thread_id: options?.messageThreadId,
      })
      .catch(() => {});

    return result;
  } catch (err) {
    controller.abort();

    // On error, still try to return accumulated partial result
    if (accumulated.length > 0) {
      log.error({ err, chatId }, "Stream error, returning partial result");
      return { result: accumulated, cost_usd: 0 };
    }

    throw err;
  }
}
