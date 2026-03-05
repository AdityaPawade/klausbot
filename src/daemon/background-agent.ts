/**
 * Background Agent Spawner
 *
 * Spawns `claude --resume <sessionId> -p "continue..."` as a detached background
 * process. Writes task files so the existing task-watcher sends Telegram
 * notifications on completion.
 *
 * Returns a RescuedProcess handle so the rescue monitor can track activity
 * and enforce safety timeouts.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { KLAUSBOT_HOME } from "../memory/home.js";
import { createChildLogger } from "../utils/logger.js";
import { writeMcpConfigFile, getHooksConfig } from "./spawner.js";
import type { ToolUseEntry, ClaudeResponse } from "./spawner.js";
import type { RescuedProcess } from "./rescue-monitor.js";

const log = createChildLogger("background-agent");

const TASKS_DIR = path.join(KLAUSBOT_HOME, "tasks");
const ACTIVE_DIR = path.join(TASKS_DIR, "active");
const COMPLETED_DIR = path.join(TASKS_DIR, "completed");

const BASE_RESUME_PROMPT = `You are now continuing as a background agent. The user already received your immediate response.

Continue with the background work you described when you called start_background_task. Work autonomously — read files, write code, search the web, use any tools needed.

For complex tasks that benefit from parallel investigation (research from multiple angles, competing hypotheses, multi-part analysis), consider using an agent team — spawn teammates to work different aspects simultaneously, then synthesize their findings.

When finished, output ONLY your final result or summary — this is delivered directly to the user as a follow-up message.

## Output Discipline
- Start directly with the content. No preamble, no "Here's what I found", no "Let me compile this".
- Do NOT include internal reasoning, planning notes, or transition phrases.
- Write as if you're sending the user a message — conversational, natural, concise.
- If the task produced a report or analysis, lead with the key finding, then details.`;

const CODING_ADDENDUM = `

## Tool Routing
- Read files with Read, not cat/head/tail
- Edit files with Edit, not sed/awk — always Read before Edit/Write
- Create files with Write, not echo/heredoc
- Search files with Glob, not find/ls
- Search content with Grep, not grep/rg

## Git Safety
- Never modify git config
- Never force-push, reset --hard, or amend commits unless explicitly asked
- Never skip hooks (--no-verify) unless explicitly asked
- Use HEREDOC for commit messages`;

const GENERAL_ADDENDUM = `

## Memory-First Rule
Before doing any work, check conversation history and memory for prior work on the same topic.
If recent work exists, summarize it — don't redo it. Duplicate work is a failure.`;

/**
 * Build the resume prompt based on task kind
 */
function buildResumePrompt(kind: "coding" | "general"): string {
  return kind === "coding"
    ? BASE_RESUME_PROMPT + CODING_ADDENDUM
    : BASE_RESUME_PROMPT + GENERAL_ADDENDUM;
}

export interface BackgroundAgentOptions {
  /** Session ID from the dispatcher's just-completed session */
  sessionId: string;
  /** Telegram chat ID for notification routing */
  chatId: number;
  /** Unique task ID */
  taskId: string;
  /** Human-readable task description */
  description: string;
  /** Task kind: 'coding' for programming, 'general' for research/conversation */
  kind?: "coding" | "general";
  /** Model override */
  model?: string;
}

/**
 * Spawn a background agent using `claude --resume`.
 *
 * 1. Writes active task file
 * 2. Spawns `claude --resume <sessionId> -p "continue..."` as detached process
 * 3. On completion, writes completed task file (task-watcher sends notification)
 * 4. Returns a RescuedProcess handle for rescue-monitor tracking
 */
export function spawnBackgroundAgent(
  options: BackgroundAgentOptions,
): RescuedProcess {
  const {
    sessionId,
    chatId,
    taskId,
    description,
    kind = "general",
    model,
  } = options;

  // Ensure task directories exist
  mkdirSync(ACTIVE_DIR, { recursive: true });
  mkdirSync(COMPLETED_DIR, { recursive: true });

  // Write active task file
  const activeTaskPath = path.join(ACTIVE_DIR, `${taskId}.json`);
  const taskData = {
    id: taskId,
    chatId: String(chatId),
    description,
    startedAt: new Date().toISOString(),
    sessionId,
  };
  writeFileSync(activeTaskPath, JSON.stringify(taskData, null, 2));
  log.info(
    { taskId, sessionId, chatId, description, kind },
    "Background agent starting",
  );

  // Build MCP config + hooks
  const mcpConfigPath = writeMcpConfigFile();
  const settingsJson = JSON.stringify(getHooksConfig());

  // Build args
  const args = [
    "--resume",
    sessionId,
    "--dangerously-skip-permissions",
    "-p",
    buildResumePrompt(kind),
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsJson,
    "--disallowedTools",
    "Task,TaskOutput",
  ];
  if (model) {
    args.push("--model", model);
  }

  // Build environment
  const env = {
    ...process.env,
    KLAUSBOT_CHAT_ID: String(chatId),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };

  const claude = spawn("claude", args, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: KLAUSBOT_HOME,
    env,
  });

  let accumulated = "";
  const toolUseEntries: ToolUseEntry[] = [];
  let currentToolName = "";
  let currentToolInput = "";

  // Parse NDJSON stream — accumulate text and track tool use
  const rl = createInterface({ input: claude.stdout! });
  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line);

      // Text accumulation
      if (event.type === "content_block_delta" && event.delta?.text) {
        accumulated += event.delta.text;
      }
      if (event.type === "result" && event.result !== undefined) {
        accumulated = event.result;
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
          parsedInput = { _raw: currentToolInput };
        }
        toolUseEntries.push({ name: currentToolName, input: parsedInput });
        currentToolName = "";
        currentToolInput = "";
      }

      // MCP tool calls arrive as "assistant" message events
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
    } catch {
      // skip non-JSON
    }
  });

  // Collect stderr for debugging
  let stderr = "";
  claude.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  // Completion promise — resolves when process finishes
  const completionPromise = new Promise<ClaudeResponse>((resolve, reject) => {
    claude.on("close", (code) => {
      const isSuccess = code === 0;

      const completedData = {
        id: taskId,
        chatId: String(chatId),
        description,
        startedAt: taskData.startedAt,
        completedAt: new Date().toISOString(),
        status: isSuccess ? "success" : "failed",
        summary: accumulated || `Exited with code ${code}`,
        error: !isSuccess ? stderr.slice(0, 500) : undefined,
      };

      // Write completed task file → task-watcher picks it up
      const completedPath = path.join(COMPLETED_DIR, `${taskId}.json`);
      writeFileSync(completedPath, JSON.stringify(completedData, null, 2));

      // Remove active task file
      try {
        unlinkSync(activeTaskPath);
      } catch {
        // Already removed or doesn't exist
      }

      log.info(
        {
          taskId,
          status: completedData.status,
          resultLength: accumulated.length,
          code,
        },
        "Background agent finished",
      );

      if (isSuccess) {
        resolve({
          result: accumulated,
          cost_usd: 0,
          session_id: sessionId,
          duration_ms: Date.now() - new Date(taskData.startedAt).getTime(),
          is_error: false,
          toolUse: [...toolUseEntries],
        });
      } else {
        reject(
          new Error(
            stderr.slice(0, 200) || `Background agent exited with code ${code}`,
          ),
        );
      }
    });

    claude.on("error", (err) => {
      log.error({ taskId, err }, "Background agent spawn error");

      // Write failed task
      const completedData = {
        id: taskId,
        chatId: String(chatId),
        description,
        startedAt: taskData.startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        summary: `Spawn error: ${err.message}`,
        error: err.message,
      };
      const completedPath = path.join(COMPLETED_DIR, `${taskId}.json`);
      writeFileSync(completedPath, JSON.stringify(completedData, null, 2));

      try {
        unlinkSync(activeTaskPath);
      } catch {
        // Already removed
      }

      reject(err);
    });
  });

  // Build and return the RescuedProcess handle
  return {
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
}
