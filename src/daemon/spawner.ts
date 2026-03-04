import { spawn } from "child_process";
import { createInterface } from "readline";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";
import { Logger } from "pino";
import { createChildLogger } from "../utils/logger.js";
import { KLAUSBOT_HOME, buildSystemPrompt } from "../memory/index.js";
import { handleTimeout } from "./transcript.js";

/**
 * Get MCP server configuration for klausbot cron tools
 * Uses same invocation method as current process (works in dev and production)
 *
 * - Dev: `node dist/index.js daemon` → MCP uses `node dist/index.js mcp-server`
 * - Prod: `klausbot daemon` → MCP uses `node /path/to/klausbot mcp-server`
 *
 * @returns MCP config object for --mcp-config flag
 */
export function getMcpConfig(): object {
  return {
    mcpServers: {
      klausbot: {
        command: process.argv[0], // node executable
        args: [process.argv[1], "mcp"], // [script path, subcommand]
        env: {},
      },
    },
  };
}

/**
 * Get Claude Code hooks configuration
 * Uses exact path to current process for reliable hook invocation
 *
 * Hook lifecycle:
 * - SessionStart: Injects datetime + recent summaries into context
 * - PreCompact: Saves state before context compaction (future use)
 * - SessionEnd: Stores transcript with summary
 *
 * @returns Settings object with hooks configuration
 */
export function getHooksConfig(): object {
  // Build command using same invocation as current process
  // Dev: node dist/index.js → node dist/index.js hook start
  // Prod: node /usr/local/bin/klausbot → node /usr/local/bin/klausbot hook start
  const nodeExecutable = process.argv[0];
  const scriptPath = process.argv[1];
  const baseCommand = `"${nodeExecutable}" "${scriptPath}"`;

  return {
    hooks: {
      SessionStart: [
        {
          // Match startup and resume events (not clear/compact which are fresh starts)
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: `${baseCommand} hook start`,
              timeout: 10, // 10 seconds max
            },
          ],
        },
      ],
      PreCompact: [
        {
          hooks: [
            {
              type: "command",
              command: `${baseCommand} hook compact`,
              timeout: 30, // 30 seconds for state save
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: `${baseCommand} hook end`,
              timeout: 60, // 60 seconds for summary generation
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write MCP config to a temp file for Claude CLI
 * Claude CLI requires a file path for --mcp-config flag
 *
 * @returns Path to temporary config file
 */
export function writeMcpConfigFile(): string {
  const config = getMcpConfig();
  const configPath = path.join(os.tmpdir(), `klausbot-mcp-${process.pid}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** Tool use entry captured from stream events */
export interface ToolUseEntry {
  name: string;
  input: Record<string, unknown>;
}

/** Claude Code response structure */
export interface ClaudeResponse {
  /** Response text from Claude */
  result: string;
  /** Cost in USD for this query */
  cost_usd: number;
  /** Session ID for this interaction */
  session_id: string;
  /** Duration of the query in milliseconds */
  duration_ms: number;
  /** Whether the response is an error */
  is_error: boolean;
  /** Tool uses performed during the session (captured from stream events) */
  toolUse?: ToolUseEntry[];
  /** Whether this response was resolved early via rescue (process still running) */
  rescued?: boolean;
}

/** Handle for a rescued process — allows monitoring after early resolution */
export interface RescueHandle {
  /** Get accumulated text at any point */
  getAccumulated: () => string;
  /** Resolves when process actually finishes (after rescue) */
  completion: Promise<ClaudeResponse>;
  /** Session ID (may be empty until process completes) */
  sessionId: string;
  /** Get tool-use entries collected so far */
  toolUseSoFar: () => ToolUseEntry[];
  /** Kill the process */
  kill: () => void;
}

/** Options for spawning Claude Code */
export interface SpawnerOptions {
  /** Timeout in milliseconds (default: 90000 = 90s) */
  timeout?: number;
  /** Model to use (for future /model command) */
  model?: string;
  /** Additional instructions appended to system prompt (for bootstrap mode) */
  additionalInstructions?: string;
  /** Telegram chat ID — propagated to hooks/MCP for per-chat memory isolation */
  chatId?: number;
  /** If set, resolve promise early with partial text at this threshold (ms) */
  rescueThresholdMs?: number;
  /** Called when rescue triggers — receives handle to monitor the still-running process */
  onRescue?: (handle: RescueHandle) => void;
  /** Inactivity timeout after first activity — resets on each event (default: none) */
  inactivityTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 90000; // 90 seconds — main agent is a fast dispatcher

const logger: Logger = createChildLogger("spawner");

/**
 * Query Claude Code CLI with a prompt
 *
 * CRITICAL: Uses stdio: ['inherit', 'pipe', 'pipe'] to avoid hang bug
 * See: https://github.com/anthropics/claude-code/issues/771
 *
 * @param prompt - The prompt to send to Claude
 * @param options - Spawn options (timeout, model)
 * @returns Claude's response
 * @throws Error with descriptive message on failure
 */
export async function queryClaudeCode(
  prompt: string,
  options: SpawnerOptions = {},
): Promise<ClaudeResponse> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const startTime = Date.now();

  // Log prompt (truncated for readability)
  const truncatedPrompt =
    prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt;
  logger.info(
    {
      prompt: truncatedPrompt,
      timeout,
      model: options.model,
      cwd: KLAUSBOT_HOME,
    },
    "Spawning Claude Code",
  );

  return new Promise((resolve, reject) => {
    // Build system prompt from identity files + retrieval instructions
    let systemPrompt = buildSystemPrompt();

    // Append additional instructions if provided (for bootstrap mode)
    if (options.additionalInstructions) {
      systemPrompt += "\n\n" + options.additionalInstructions;
    }

    // Guard against E2BIG: Linux MAX_ARG_STRLEN is 128KB per argument.
    // Truncate if the system prompt exceeds 120KB (leaving 8KB margin).
    const MAX_SYSTEM_PROMPT_BYTES = 120_000;
    const promptBytes = Buffer.byteLength(systemPrompt, "utf-8");
    if (promptBytes > MAX_SYSTEM_PROMPT_BYTES) {
      logger.warn(
        { promptBytes, limit: MAX_SYSTEM_PROMPT_BYTES },
        "System prompt exceeds size limit, truncating",
      );
      systemPrompt = systemPrompt.slice(0, MAX_SYSTEM_PROMPT_BYTES);
    }

    // Write MCP config to temp file for Claude CLI
    const mcpConfigPath = writeMcpConfigFile();

    // Build hooks settings JSON
    const hooksSettings = getHooksConfig();
    const settingsJson = JSON.stringify(hooksSettings);

    // Wrap user prompt in XML tags for security
    // Prevents shell injection and prompt injection from Telegram input
    // The reminder after </user_message> ensures Claude always outputs text
    // even when performing tool-use (file writes, memory updates, etc.)
    const wrappedPrompt = `<user_message>\n${prompt}\n</user_message>\n<reminder>You MUST include a conversational text response. If you performed any actions (file writes, memory updates, etc.), acknowledge them naturally. NEVER return empty.</reminder>`;

    // Build command arguments
    // Use stream-json to capture tool-use events (needed for empty-response context)
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

    logger.debug({ hooksConfig: hooksSettings }, "Hook configuration");

    // Build environment with chat ID
    const env = { ...process.env };
    if (options.chatId !== undefined) {
      env.KLAUSBOT_CHAT_ID = String(options.chatId);
    }

    // CRITICAL: stdin must inherit to avoid hang bug (issue #771)
    const claude = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: KLAUSBOT_HOME, // Working directory for agentic file access
      env,
    });

    let stderr = "";
    let timedOut = false;
    let rescued = false;

    // NDJSON stream state
    let accumulated = "";
    let costUsd = 0;
    let sessionId = "";
    let isError = false;
    const toolUseEntries: ToolUseEntry[] = [];

    // Track current tool_use content block being built
    let currentToolName = "";
    let currentToolInput = "";

    // Completion promise for post-rescue monitoring
    let resolveCompletion: ((response: ClaudeResponse) => void) | null = null;
    const completionPromise = new Promise<ClaudeResponse>((res) => {
      resolveCompletion = res;
    });

    // --- Rescue timer (resolve early, keep process alive) ---
    let rescueTimerId: ReturnType<typeof setTimeout> | null = null;
    if (options.rescueThresholdMs && options.onRescue) {
      rescueTimerId = setTimeout(() => {
        if (rescued) return; // Already rescued (shouldn't happen)
        rescued = true;

        const duration_ms = Date.now() - startTime;
        logger.info(
          { duration_ms, accumulatedLength: accumulated.length },
          "Rescue threshold reached, resolving early",
        );

        const partialResponse: ClaudeResponse = {
          result: accumulated,
          cost_usd: 0,
          session_id: sessionId,
          duration_ms,
          is_error: false,
          toolUse: toolUseEntries.length > 0 ? [...toolUseEntries] : undefined,
          rescued: true,
        };

        // Provide handle for the caller to monitor the still-running process
        const handle: RescueHandle = {
          getAccumulated: () => accumulated,
          completion: completionPromise,
          sessionId,
          toolUseSoFar: () => [...toolUseEntries],
          kill: () => {
            claude.kill("SIGTERM");
            setTimeout(() => {
              if (!claude.killed) claude.kill("SIGKILL");
            }, 5000);
          },
        };

        options.onRescue!(handle);
        resolve(partialResponse);
      }, options.rescueThresholdMs);
    }

    // --- Activity-based safety timeout ---
    const inactivityMs = options.inactivityTimeoutMs;
    let hasActivity = false;

    const killProcess = () => {
      timedOut = true;
      const reason = hasActivity ? "inactivity" : "no output";
      logger.warn(
        { resultLength: accumulated.length, reason },
        "Claude timed out, killing process",
      );
      claude.kill("SIGTERM");
      setTimeout(() => {
        if (!claude.killed) claude.kill("SIGKILL");
      }, 5000);
    };

    let timeoutId = setTimeout(killProcess, timeout);

    /** Reset timeout on activity — switches to inactivity window after first event.
     *  Keeps resetting even after rescue so long-running tool work isn't killed. */
    const onActivity = () => {
      if (timedOut) return;
      hasActivity = true;
      clearTimeout(timeoutId);
      const nextTimeout = inactivityMs ?? timeout;
      timeoutId = setTimeout(killProcess, nextTimeout);
    };

    // Parse NDJSON events from stream-json output
    const rl = createInterface({ input: claude.stdout! });

    rl.on("line", (line) => {
      try {
        const event = JSON.parse(line);

        // Any parseable NDJSON event counts as activity
        onActivity();

        // Text delta — accumulate response text
        if (event.type === "content_block_delta" && event.delta?.text) {
          accumulated += event.delta.text;
        }

        // Tool use start — capture tool name
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          currentToolName = event.content_block.name ?? "";
          currentToolInput = "";
        }

        // Tool use input delta — accumulate JSON input
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
            // Partial or malformed input — store raw
            parsedInput = { _raw: currentToolInput };
          }
          toolUseEntries.push({ name: currentToolName, input: parsedInput });
          currentToolName = "";
          currentToolInput = "";
        }

        // MCP tool calls arrive as "assistant" message events with tool_use content blocks
        const eventAny = event as Record<string, unknown>;
        if (
          eventAny.type === "assistant" &&
          (eventAny.message as Record<string, unknown>)?.content
        ) {
          const content = (eventAny.message as Record<string, unknown>)
            .content as Array<{
            type: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
          for (const block of content) {
            if (block.type === "tool_use" && block.name) {
              toolUseEntries.push({
                name: block.name,
                input: block.input ?? {},
              });
            }
          }
        }

        // Final result event — use authoritative values
        if (event.type === "result") {
          if (event.result !== undefined) accumulated = event.result;
          // CLI v2.1+ uses total_cost_usd, older versions use cost_usd
          const eventCost =
            (event as Record<string, unknown>).total_cost_usd ?? event.cost_usd;
          if (eventCost !== undefined) costUsd = eventCost as number;
          if (event.session_id !== undefined) sessionId = event.session_id;
          if (event.is_error !== undefined) isError = event.is_error;
        }
      } catch {
        // Skip non-JSON lines
      }
    });

    // Collect stderr
    claude.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Single resolution point: process close
    claude.on("close", (code) => {
      clearTimeout(timeoutId);
      if (rescueTimerId) clearTimeout(rescueTimerId);
      const duration_ms = Date.now() - startTime;

      const finalResponse: ClaudeResponse = {
        result: accumulated,
        cost_usd: costUsd,
        session_id: sessionId,
        duration_ms,
        is_error: isError,
        toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
      };

      // Always resolve completionPromise (for rescue monitor)
      if (resolveCompletion) {
        resolveCompletion(finalResponse);
      }

      // If already rescued, don't resolve the main promise again
      if (rescued) {
        logger.info(
          {
            duration_ms,
            cost_usd: costUsd,
            resultLength: accumulated.length,
          },
          "Rescued process completed",
        );
        return;
      }

      // Handle timeout
      if (timedOut) {
        const recovered = handleTimeout(KLAUSBOT_HOME);
        if (recovered) {
          logger.info({ duration_ms }, "Recovered response from timeout");
          resolve({
            result: recovered,
            cost_usd: 0,
            session_id: "recovered",
            duration_ms,
            is_error: false,
            toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
          });
          return;
        }

        const timeoutSec = Math.round(timeout / 1000);
        const error = `Response timed out after ${timeoutSec}s — if a background task was started, you'll still be notified when it completes`;
        logger.error({ timeout, duration_ms }, "Claude timed out, no recovery");
        reject(new Error(error));
        return;
      }

      // Handle non-zero exit code
      if (code !== 0) {
        const stderrTruncated =
          stderr.length > 200 ? `${stderr.slice(0, 200)}...` : stderr;
        const error = `Claude exited with code ${code}: ${stderrTruncated}`;
        logger.error({ code, stderr: stderrTruncated, duration_ms }, error);
        reject(new Error(error));
        return;
      }

      const truncatedResult =
        finalResponse.result.length > 200
          ? `${finalResponse.result.slice(0, 200)}...`
          : finalResponse.result;
      logger.info(
        {
          duration_ms,
          cost_usd: finalResponse.cost_usd,
          session_id: finalResponse.session_id,
          is_error: finalResponse.is_error,
          resultLength: finalResponse.result.length,
          result: truncatedResult,
          toolUseCount: toolUseEntries.length,
        },
        "Claude Code responded",
      );

      resolve(finalResponse);
    });

    // Handle spawn errors (e.g., claude not found)
    claude.on("error", (err) => {
      clearTimeout(timeoutId);
      if (rescueTimerId) clearTimeout(rescueTimerId);
      const error = `Failed to start Claude: ${err.message}`;
      logger.error({ err }, error);
      reject(new Error(error));
    });
  });
}
