/**
 * CodexBackend — wraps the OpenAI Codex CLI as an LLMBackend.
 *
 * Spawns `codex exec --json` for each query, parses the JSONL event stream,
 * and reshapes the output into BackendResponse / BackendStreamResult.
 *
 * Design notes:
 *  - Codex CLI emits one `item.completed` per finished item (agent_message,
 *    function_call, etc.) — there are no token-by-token text deltas. The
 *    `stream()` path therefore fires `onChunk` once per agent_message item;
 *    Telegram still benefits because each tool turn surfaces text as it
 *    completes, but there is no typewriter effect.
 *  - Session resume uses `codex exec resume <session_id>` so context survives
 *    across the 30-min reuse window driven by session-tracker.ts.
 *  - Codex has no `--system-prompt` flag and ships its own coding-agent
 *    persona; we prepend a compact klausbot identity to the user prompt so
 *    the agent behaves like Klaus instead of a code editor. Full identity
 *    files are still reachable via the search_memories MCP tool.
 *  - Sandbox defaults to read-only — klausbot's writes happen via MCP tools
 *    (out of the codex sandbox), so this stays safe while preventing the
 *    model from doing unexpected file edits via codex's built-in apply_patch.
 *  - Cost = 0 for ChatGPT-Plus subscription auth.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import type { Logger } from "pino";
import { createChildLogger } from "../utils/logger.js";
import { KLAUSBOT_HOME } from "../memory/index.js";
import type {
  BackendOptions,
  BackendResponse,
  BackendRescueHandle,
  BackendStreamOptions,
  BackendStreamResult,
  LLMBackend,
  ToolUseEntry,
} from "./types.js";

const log: Logger = createChildLogger("codex-backend");

const DEFAULT_TIMEOUT = 300_000; // 5 min — codex with reasoning can be slower than Claude Code
const DEFAULT_BINARY = "codex";

/** Allowed sandbox modes for `codex exec --sandbox`. */
export type CodexSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

/** Allowed reasoning effort levels for codex. */
export type CodexReasoningEffort = "low" | "medium" | "high";

/** Configuration for the Codex backend (all fields optional with sensible defaults). */
export interface CodexBackendConfig {
  /** Path or name of the codex binary. Default: "codex" (PATH lookup). */
  binary?: string;
  /** Default model id (e.g. "gpt-5-codex"). If unset, codex picks its default. */
  model?: string;
  /**
   * Sandbox policy. Default: "danger-full-access".
   * Klausbot needs unrestricted MCP tool calls (cron mutations, memory writes)
   * to do its job, and `codex exec` only auto-approves MCP calls under
   * danger-full-access in non-interactive mode. This mirrors klausbot's
   * existing Claude Code path which uses --dangerously-skip-permissions.
   * The trust boundary here is "klausbot daemon == Pi owner == single user".
   */
  sandbox?: CodexSandbox;
  /** Working directory for the agent. Default: KLAUSBOT_HOME. */
  cwd?: string;
  /** Reasoning effort override. Optional. */
  reasoningEffort?: CodexReasoningEffort;
  /** Pass --skip-git-repo-check (KLAUSBOT_HOME isn't a git repo). Default: true. */
  skipGitRepoCheck?: boolean;
}

/** Internal resolved-config shape — all defaultable fields are concrete. */
interface ResolvedCodexConfig {
  binary: string;
  model?: string;
  sandbox: CodexSandbox;
  cwd: string;
  reasoningEffort?: CodexReasoningEffort;
  skipGitRepoCheck: boolean;
}

/** Codex JSONL event — only the fields we care about. */
interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    name?: string;
    arguments?: string;
    output?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

/** Compact klausbot identity — prepended to every prompt because codex has
 *  no --system-prompt and ships its own coding-agent persona by default. */
const CODEX_COMPACT_SYSTEM_PROMPT = [
  "You are klausbot, a Telegram personal assistant for Aditya.",
  "Speak warmly and concisely — replies are usually 1-3 sentences.",
  "Use the klausbot MCP tools (schedule a cron, search memory, manage projects, run background tasks, etc.) when the user asks for an action they cover.",
  "When the user just chats, reply naturally without calling any tool.",
  "If you call tools, ALWAYS produce a final conversational text reply afterward — never return empty.",
  "You are NOT a code editor; do not attempt to edit files via apply_patch unless the user explicitly asks for code changes.",
].join(" ");

/** Build the wrapped prompt: identity + user message + reminder. Mirrors
 *  the Claude Code / Ollama path so behavior is consistent. */
export function buildCodexPrompt(
  prompt: string,
  additionalInstructions?: string,
): string {
  let sys = CODEX_COMPACT_SYSTEM_PROMPT;
  if (additionalInstructions) {
    sys += "\n\n" + additionalInstructions;
  }
  return (
    `<klausbot-system>\n${sys}\n</klausbot-system>\n` +
    `<user_message>\n${prompt}\n</user_message>\n` +
    `<reminder>You MUST include a conversational text response. ` +
    `If you performed any actions (memory updates, etc.), acknowledge them naturally. ` +
    `NEVER return empty.</reminder>`
  );
}

/** Build the codex exec argv for a given prompt + options. Pure function — exported for tests. */
export function buildCodexArgs(
  cfg: ResolvedCodexConfig,
  options: BackendStreamOptions,
  wrappedPrompt: string,
): string[] {
  const isResume = !!options.resumeSessionId;
  const args: string[] = ["exec"];
  if (isResume) {
    args.push("resume", options.resumeSessionId!);
  }
  args.push("--json");
  if (cfg.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  // --sandbox and -C are only valid on the fresh `codex exec` form, NOT on
  // `codex exec resume` — clap rejects them with "unexpected argument".
  // The resumed session re-uses the original sandbox + cwd recorded with
  // the thread, which is the correct behavior anyway.
  if (!isResume) {
    args.push("--sandbox", cfg.sandbox);
    args.push("-C", cfg.cwd);
  }

  // IMPORTANT: ignore options.model. The dispatch layer passes the top-level
  // `model` field from klausbot.json, which is intended for Claude Code (e.g.
  // "claude-opus-4-6") and is not a valid Codex model. Use only cfg.model
  // (sourced from backendConfig.codex.model). Empty = let codex pick its default.
  const modelOverride = cfg.model;
  if (modelOverride) {
    args.push("-m", modelOverride);
  }
  if (cfg.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${cfg.reasoningEffort}"`);
  }
  args.push(wrappedPrompt);
  return args;
}

interface RunResult {
  result: string;
  cost_usd: number;
  session_id: string;
  duration_ms: number;
  is_error: boolean;
  toolUse?: ToolUseEntry[];
  rescued?: boolean;
}

export class CodexBackend implements LLMBackend {
  readonly id = "codex";
  private readonly cfg: ResolvedCodexConfig;

  constructor(cfg: CodexBackendConfig = {}) {
    this.cfg = {
      binary: cfg.binary ?? DEFAULT_BINARY,
      model: cfg.model,
      sandbox: cfg.sandbox ?? "danger-full-access",
      cwd: cfg.cwd ?? KLAUSBOT_HOME,
      reasoningEffort: cfg.reasoningEffort,
      skipGitRepoCheck: cfg.skipGitRepoCheck ?? true,
    };
  }

  /** Codex is healthy if the binary exists AND `codex login status` reports logged in. */
  async health(): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let proc;
      try {
        proc = spawn(this.cfg.binary, ["login", "status"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ ok: false, message: `Failed to spawn codex: ${msg}` });
        return;
      }

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ ok: false, message: "codex login status timed out" });
      }, 5000);

      proc.stdout!.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      proc.stderr!.on("data", (b: Buffer) => {
        stderr += b.toString();
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        // codex login status writes "Logged in" to stderr; check both streams
        const combined = stdout + stderr;
        if (code === 0 && /Logged in/i.test(combined)) {
          resolve({ ok: true });
        } else {
          const msg = combined.trim() || "(no output)";
          resolve({
            ok: false,
            message: `codex login status: exit ${code} — ${msg}`,
          });
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          message: `Failed to invoke codex: ${err.message}`,
        });
      });
    });
  }

  async query(
    prompt: string,
    options: BackendOptions = {},
  ): Promise<BackendResponse> {
    const r = await runCodex(this.cfg, prompt, options, undefined);
    return {
      result: r.result,
      cost_usd: r.cost_usd,
      session_id: r.session_id,
      duration_ms: r.duration_ms,
      is_error: r.is_error,
      toolUse: r.toolUse,
      rescued: r.rescued,
    };
  }

  async stream(
    prompt: string,
    options: BackendStreamOptions,
    onChunk: (text: string) => void,
  ): Promise<BackendStreamResult> {
    const r = await runCodex(this.cfg, prompt, options, onChunk);
    return {
      result: r.result,
      cost_usd: r.cost_usd,
      session_id: r.session_id,
      toolUse: r.toolUse,
      messageSent: false,
      rescued: r.rescued,
    };
  }
}

async function runCodex(
  cfg: ResolvedCodexConfig,
  prompt: string,
  options: BackendStreamOptions,
  onChunk?: (text: string) => void,
): Promise<RunResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const isResume = !!options.resumeSessionId;

  const wrappedPrompt = buildCodexPrompt(
    prompt,
    options.additionalInstructions,
  );
  const args = buildCodexArgs(cfg, options, wrappedPrompt);

  log.info(
    {
      isResume,
      model: cfg.model || "(codex default)",
      sandbox: cfg.sandbox,
      cwd: cfg.cwd,
      promptBytes: Buffer.byteLength(prompt, "utf-8"),
      resumeSessionId: options.resumeSessionId ?? null,
    },
    isResume ? "Resuming Codex session" : "Spawning codex exec",
  );

  return new Promise<RunResult>((resolve, reject) => {
    const env = { ...process.env };
    if (options.chatId !== undefined) {
      env.KLAUSBOT_CHAT_ID = String(options.chatId);
    }
    // Diagnostics: make codex emit its MCP startup / tool-call / timeout timeline to stderr (otherwise
    // invisible to us). Keep it focused — suppress the HTTP/OTEL/JSON-RPC-passthrough noise. Captured
    // on close below so an intermittent "couldn't fetch" is deterministically traceable.
    if (!env.RUST_LOG) {
      env.RUST_LOG =
        "warn,codex_core=info,codex_exec=info,codex_rmcp_client=info,codex_rmcp_client::stdio_server_launcher=warn";
    }

    const proc = spawn(cfg.binary, args, {
      // stdio[0] = "ignore" so codex doesn't try to read additional input
      // from stdin (which it does whenever stdin is open — see exec --help).
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cfg.cwd,
      env,
    });

    let accumulated = "";
    let sessionId = "";
    let stderrBuf = "";
    let timedOut = false;
    let rescued = false;
    let isError = false;
    const toolUseEntries: ToolUseEntry[] = [];

    let resolveCompletion: ((r: RunResult) => void) | null = null;
    const completionPromise = new Promise<RunResult>((res) => {
      resolveCompletion = res;
    });

    let rescueTimerId: ReturnType<typeof setTimeout> | null = null;
    if (options.rescueThresholdMs && options.onRescue) {
      rescueTimerId = setTimeout(() => {
        if (rescued) return;
        rescued = true;
        const duration_ms = Date.now() - startTime;
        log.info(
          { duration_ms, accumulatedLength: accumulated.length },
          "Codex rescue threshold reached, resolving early",
        );

        const partial: RunResult = {
          result: accumulated,
          cost_usd: 0,
          session_id: sessionId,
          duration_ms,
          is_error: false,
          toolUse: toolUseEntries.length > 0 ? [...toolUseEntries] : undefined,
          rescued: true,
        };
        const handle: BackendRescueHandle = {
          getAccumulated: () => accumulated,
          completion: completionPromise.then((r) => ({
            result: r.result,
            cost_usd: r.cost_usd,
            session_id: r.session_id,
            duration_ms: r.duration_ms,
            is_error: r.is_error,
            toolUse: r.toolUse,
            rescued: r.rescued,
          })),
          sessionId,
          toolUseSoFar: () => [...toolUseEntries],
          kill: () => {
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL");
            }, 5000);
          },
        };
        options.onRescue!(handle);
        resolve(partial);
      }, options.rescueThresholdMs);
    }

    const inactivityMs = options.inactivityTimeoutMs;
    let hasActivity = false;
    const killProcess = () => {
      timedOut = true;
      const reason = hasActivity ? "inactivity" : "no output";
      log.warn(
        { resultLength: accumulated.length, reason },
        "Codex timed out, killing process",
      );
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };
    let timeoutId = setTimeout(killProcess, timeout);
    const onActivity = () => {
      if (timedOut) return;
      hasActivity = true;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(killProcess, inactivityMs ?? timeout);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        if (rescueTimerId) clearTimeout(rescueTimerId);
        proc.kill("SIGTERM");
      });
    }

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      // Skip non-JSON status lines like "Reading additional input from stdin..."
      if (!trimmed.startsWith("{")) return;
      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      onActivity();

      switch (event.type) {
        case "thread.started":
          if (event.thread_id) sessionId = event.thread_id;
          break;
        case "item.completed": {
          const item = event.item;
          if (!item) break;
          if (item.type === "agent_message" && item.text) {
            // Multiple agent_messages can appear across tool turns — concat
            // with newlines so the user sees the full transcript.
            const chunk = accumulated.length > 0 ? "\n" + item.text : item.text;
            accumulated += chunk;
            if (onChunk) onChunk(chunk);
          } else if (
            item.type === "function_call" ||
            item.type === "local_shell_call" ||
            item.type === "mcp_tool_call"
          ) {
            // Drop any pre-tool-call "preamble" narration; keep only the final answer the model
            // produces after the last tool call (stops "Pulling the trade-card…" from leaking).
            accumulated = "";
            const name = item.name ?? item.type;
            let parsedArgs: Record<string, unknown> = {};
            if (item.arguments) {
              try {
                parsedArgs = JSON.parse(item.arguments);
              } catch {
                parsedArgs = { _raw: item.arguments };
              }
            }
            toolUseEntries.push({ name, input: parsedArgs });
          }
          break;
        }
        case "error":
          isError = true;
          break;
        default:
          // turn.started, turn.completed, item.started, etc. — ignore
          break;
      }
    });

    proc.stderr!.on("data", (b: Buffer) => {
      stderrBuf += b.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (rescueTimerId) clearTimeout(rescueTimerId);
      const duration_ms = Date.now() - startTime;

      const final: RunResult = {
        result: accumulated,
        cost_usd: 0,
        session_id: sessionId,
        duration_ms,
        is_error: isError || (code !== 0 && !rescued && !timedOut),
        toolUse: toolUseEntries.length > 0 ? toolUseEntries : undefined,
      };

      if (resolveCompletion) resolveCompletion(final);

      // --- Diagnostics: codex exits 0 even when it internally interrupts a tool call (the
      // "couldn't fetch / interrupted" case), so the error paths below never see it. Always log
      // timing + a tail of codex's stderr (its MCP startup/tool/timeout timeline via RUST_LOG) so
      // an intermittent failure is deterministically diagnosable from app.log. ---
      const looksFailed =
        toolUseEntries.length === 0 &&
        /could ?n.?t fetch|interrupt|timed out|no data|unable to|send .*again|once more/i.test(accumulated);
      log[looksFailed || isError || code !== 0 ? "warn" : "info"](
        {
          duration_ms,
          code,
          timedOut,
          rescued,
          toolCalls: toolUseEntries.map((t) => t.name),
          resultBytes: accumulated.length,
          looksFailed,
          stderrTail: stderrBuf.slice(-6000),
        },
        "codex run diagnostics",
      );

      if (rescued) {
        log.info(
          {
            duration_ms,
            resultLength: accumulated.length,
          },
          "Rescued codex completed",
        );
        return;
      }

      if (timedOut) {
        const timeoutSec = Math.round(timeout / 1000);
        log.error({ timeout, duration_ms }, "Codex timed out, no recovery");
        reject(
          new Error(
            `Codex response timed out after ${timeoutSec}s — if a background task was started, you'll still be notified when it completes`,
          ),
        );
        return;
      }

      if (code !== 0) {
        const stderrTrunc =
          stderrBuf.length > 200 ? `${stderrBuf.slice(0, 200)}...` : stderrBuf;
        const error = `Codex exited with code ${code}: ${stderrTrunc || "(no stderr)"}`;
        log.error({ code, stderr: stderrTrunc, duration_ms }, error);
        reject(new Error(error));
        return;
      }

      const truncatedResult =
        accumulated.length > 200
          ? `${accumulated.slice(0, 200)}...`
          : accumulated;
      log.info(
        {
          duration_ms,
          session_id: sessionId,
          resultLength: accumulated.length,
          result: truncatedResult,
          toolUseCount: toolUseEntries.length,
        },
        "Codex responded",
      );
      resolve(final);
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      if (rescueTimerId) clearTimeout(rescueTimerId);
      log.error({ err }, "Failed to spawn codex");
      reject(new Error(`Failed to start codex: ${err.message}`));
    });
  });
}
