import { randomUUID } from "crypto";
import type { MyContext } from "../telegram/index.js";
import {
  streamToTelegram,
  canStreamToChat,
  type StreamConfig,
} from "../telegram/index.js";
import {
  MessageQueue,
  queryClaudeCode,
  ensureDataDir,
  spawnBackgroundAgent,
  type ToolUseEntry,
} from "./index.js";
import {
  RescueMonitor,
  type RescueMonitorCallbacks,
} from "./rescue-monitor.js";
import type { RescueHandle } from "./spawner.js";
import { getJsonConfig } from "../config/index.js";
import type { QueuedMessage, ThreadingContext } from "./queue.js";
import {
  initPairingStore,
  createPairingMiddleware,
  handleStartCommand,
  getPairingStore,
} from "../pairing/index.js";
import { InlineKeyboard } from "grammy";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { KLAUSBOT_HOME } from "../memory/home.js";
import {
  createChildLogger,
  sendLongMessage,
  markdownToTelegramHtml,
  splitTelegramMessage,
  escapeHtml,
} from "../utils/index.js";
import { autoCommitChanges } from "../utils/git.js";
import {
  initializeHome,
  initializeEmbeddings,
  migrateEmbeddings,
  closeDb,
  invalidateIdentityCache,
  runMigrations,
  getOrchestrationInstructions,
  storeConversation,
  buildConversationContext,
} from "../memory/index.js";
import {
  needsBootstrap,
  DEFAULT_BOOTSTRAP_CONTENT,
} from "../bootstrap/index.js";
import { validateRequiredCapabilities } from "../platform/index.js";
import { startScheduler, stopScheduler, loadCronStore } from "../cron/index.js";
import {
  startHeartbeat,
  stopHeartbeat,
  shouldCollectNote,
  getNoteCollectionInstructions,
} from "../heartbeat/index.js";
import {
  startTaskWatcher,
  getActiveTasks,
  markTaskFailed,
  dismissActiveTask,
  timeAgo,
} from "./task-watcher.js";
import {
  MediaAttachment,
  transcribeAudio,
  isTranscriptionAvailable,
  saveImage,
  withRetry,
  downloadFile,
} from "../media/index.js";
import { unlinkSync } from "fs";
import os from "os";
import path from "path";

const log = createChildLogger("gateway");

/** Module state */
let queue: MessageQueue;
let isProcessing = false;
let shouldStop = false;
let stopTaskWatcher: (() => void) | null = null;
let rescueMonitor: RescueMonitor | null = null;

/** Pending failed messages awaiting user Retry/Dismiss */
const failedMessages = new Map<
  string,
  {
    chatId: number;
    text: string;
    threading?: ThreadingContext;
    createdAt: number;
  }
>();

/** Most recently active chat — used by heartbeat for target resolution */
let lastActiveChatId: number | null = null;

/** Get the most recently active chatId (null if no messages received yet) */
export function getLastActiveChatId(): number | null {
  return lastActiveChatId;
}

/** Bot instance (loaded dynamically after config validation) */
let bot: Awaited<typeof import("../telegram/index.js")>["bot"];

/**
 * Send a Retry/Dismiss inline keyboard for a failed message.
 * Prunes entries older than 1 hour to prevent unbounded growth.
 */
async function sendRetryKeyboard(
  chatId: number,
  text: string,
  reason: string,
  opts?: { messageThreadId?: number },
): Promise<void> {
  // Prune entries older than 1 hour
  const ONE_HOUR = 3_600_000;
  for (const [id, entry] of failedMessages) {
    if (Date.now() - entry.createdAt > ONE_HOUR) failedMessages.delete(id);
  }

  const retryId = randomUUID().slice(0, 8);
  failedMessages.set(retryId, {
    chatId,
    text,
    threading: opts?.messageThreadId
      ? { messageThreadId: opts.messageThreadId }
      : undefined,
    createdAt: Date.now(),
  });

  const desc = text.length > 80 ? text.slice(0, 77) + "..." : text;
  const msg =
    `Your message couldn't be completed:\n\n` +
    `<b>${escapeHtml(desc)}</b>\n` +
    `Reason: ${escapeHtml(reason)}\n\n` +
    `Would you like to retry?`;

  const keyboard = new InlineKeyboard()
    .text("Retry", `failed:retry:${retryId}`)
    .text("Dismiss", `failed:dismiss:${retryId}`);

  await bot.api.sendMessage(chatId, msg, {
    parse_mode: "HTML",
    reply_markup: keyboard,
    message_thread_id: opts?.messageThreadId,
  });
}

/**
 * Pre-process media attachments before Claude query
 * - Voice: transcribe and delete audio file
 * - Photo: save to images directory
 *
 * @returns Processed attachments with transcripts/paths filled in
 */
async function processMedia(
  attachments: MediaAttachment[],
): Promise<{ processed: MediaAttachment[]; errors: string[] }> {
  const processed: MediaAttachment[] = [];
  const errors: string[] = [];

  for (const attachment of attachments) {
    const startTime = Date.now();

    if (attachment.type === "voice") {
      // Transcribe voice
      if (!isTranscriptionAvailable()) {
        errors.push(
          "Voice transcription not available (OPENAI_API_KEY missing)",
        );
        continue;
      }

      if (!attachment.localPath) {
        errors.push("Voice file not downloaded");
        continue;
      }

      try {
        const result = await withRetry(() =>
          transcribeAudio(attachment.localPath!),
        );

        // Delete audio file after transcription (per CONTEXT.md)
        try {
          unlinkSync(attachment.localPath);
        } catch {
          // Ignore delete errors
        }

        processed.push({
          ...attachment,
          transcript: result.text,
          processingTimeMs: Date.now() - startTime,
          localPath: undefined, // Clear path since file deleted
        });

        log.info(
          {
            type: "voice",
            transcriptLength: result.text.length,
            durationMs: result.durationMs,
          },
          "Transcribed voice message",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Transcription failed: ${msg}`);
        log.error(
          { err, localPath: attachment.localPath },
          "Voice transcription failed",
        );
      }
    } else if (attachment.type === "photo") {
      // Save image
      if (!attachment.localPath) {
        errors.push("Image file not downloaded");
        continue;
      }

      try {
        const savedPath = saveImage(attachment.localPath);

        processed.push({
          ...attachment,
          localPath: savedPath, // Update to permanent path
          processingTimeMs: Date.now() - startTime,
        });

        log.info({ type: "photo", savedPath }, "Saved image");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to save image: ${msg}`);
        log.error(
          { err, localPath: attachment.localPath },
          "Image save failed",
        );
      }
    }
  }

  return { processed, errors };
}

/**
 * Build prompt text incorporating media context
 */
function buildPromptWithMedia(text: string, media: MediaAttachment[]): string {
  const voiceTranscripts = media
    .filter((m) => m.type === "voice" && m.transcript)
    .map((m) => m.transcript);

  const imagePaths = media
    .filter((m) => m.type === "photo" && m.localPath)
    .map((m) => m.localPath!);

  let prompt = text;

  // If voice-only (no text), use transcript as prompt
  if (!text.trim() && voiceTranscripts.length > 0) {
    prompt = voiceTranscripts.join("\n");
  } else if (voiceTranscripts.length > 0) {
    // Text + voice: prepend transcript context
    prompt = `[Voice message transcript: ${voiceTranscripts.join(" ")}]\n\n${text}`;
  }

  // Add image references for Claude to read
  if (imagePaths.length > 0) {
    const imageInstructions = imagePaths
      .map((p, i) => `Image ${i + 1}: ${p}`)
      .join("\n");

    prompt = `The user sent ${imagePaths.length} image(s). Read and analyze them using your Read tool:\n${imageInstructions}\n\n${prompt || "(no text, just the image(s))"}`;
  }

  return prompt;
}

/**
 * Check if Claude called start_background_task and spawn a background agent.
 * Scans toolUse entries for the MCP tool call and extracts description.
 * Registers the spawned agent with the rescue monitor for activity-based safety timeouts.
 */
function maybeSpawnBackgroundAgent(
  toolUse: ToolUseEntry[] | undefined,
  sessionId: string,
  chatId: number,
  model?: string,
): void {
  if (!toolUse) return;

  const bgTool = toolUse.find(
    (t) => t.name === "mcp__klausbot__start_background_task",
  );
  if (!bgTool) return;

  const description = (bgTool.input.description as string) ?? "Background task";
  const kind = (
    (bgTool.input.kind as string) === "coding" ? "coding" : "general"
  ) as "coding" | "general";
  const taskId = randomUUID();

  log.info(
    { taskId, sessionId, chatId, description, kind },
    "Spawning background agent from tool call",
  );

  const handle = spawnBackgroundAgent({
    sessionId,
    chatId,
    taskId,
    description,
    kind,
    model,
  });

  // Register with rescue monitor for activity-based safety timeouts
  if (rescueMonitor) {
    rescueMonitor.registerOrPrompt(
      taskId,
      handle,
      { chatId, sentText: "", originalMessage: description },
      model,
      description,
      "background",
    );
  }
}

/**
 * Start the gateway daemon
 * Initializes all components and begins processing
 */
export async function startGateway(): Promise<void> {
  // Validate required capabilities first (exits if missing)
  // No logging before this - validation must pass first
  await validateRequiredCapabilities();

  // Dynamic import telegram module AFTER validation passes
  // This prevents bot.ts from loading config before we verify it exists
  const telegram = await import("../telegram/index.js");
  bot = telegram.bot;
  const {
    createRunner,
    registerSkillCommands,
    getInstalledSkillNames,
    translateSkillCommand,
  } = telegram;

  log.info("Starting gateway...");

  // Initialize ~/.klausbot/ data home (directories only)
  // NOTE: Do NOT call initializeIdentity() here - bootstrap flow creates identity files
  initializeHome(log);

  // Create BOOTSTRAP.md if identity folder is empty (first-time setup)
  const identityDir = join(KLAUSBOT_HOME, "identity");
  const bootstrapPath = join(identityDir, "BOOTSTRAP.md");
  const soulPath = join(identityDir, "SOUL.md");
  if (!existsSync(bootstrapPath) && !existsSync(soulPath)) {
    writeFileSync(bootstrapPath, DEFAULT_BOOTSTRAP_CONTENT);
    log.info("Created BOOTSTRAP.md for first-time setup");
  }

  initializeEmbeddings();

  // Run database migrations (creates tables if needed)
  runMigrations();
  log.info("Database migrations complete");

  // Migrate embeddings from JSON to SQLite (idempotent)
  await migrateEmbeddings();

  // Log media capabilities
  log.info(
    {
      voiceTranscription: isTranscriptionAvailable(),
      imageAnalysis: true, // Always available (Claude vision)
    },
    "Media capabilities",
  );

  // Initialize cron system
  startScheduler();
  log.info(
    { jobs: loadCronStore().jobs.filter((j) => j.enabled).length },
    "Cron scheduler initialized",
  );

  // Initialize heartbeat system
  startHeartbeat();
  log.info("Heartbeat scheduler initialized");

  // Initialize background task watcher
  stopTaskWatcher = startTaskWatcher({
    sendMessage: async (chatId: string, text: string) => {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch {
        // HTML parse failed — strip tags and send as plain text
        await bot.api.sendMessage(chatId, text.replace(/<[^>]*>/g, ""));
      }
    },
    onNotified: async (task) => {
      const transcript = [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: `[Background task] ${task.description}` },
            ],
          },
          timestamp: task.startedAt,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: task.summary || "Task completed." },
            ],
          },
          timestamp: task.completedAt || new Date().toISOString(),
        }),
      ].join("\n");

      const summary =
        `Background task: ${task.description}` +
        (task.summary ? ` — ${task.summary.slice(0, 150)}` : "");

      storeConversation({
        sessionId: `bg-task-${task.id}`,
        startedAt: task.startedAt,
        endedAt: task.completedAt || new Date().toISOString(),
        transcript,
        summary: summary.slice(0, 300),
        messageCount: 2,
        chatId: Number(task.chatId),
      });
    },
  });
  log.info("Background task watcher initialized");

  // Recover orphaned background tasks (tasks stuck in active/ from previous crash)
  const orphanedTasks = getActiveTasks().sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  if (orphanedTasks.length > 0) {
    log.info(
      { count: orphanedTasks.length },
      "Found orphaned background tasks from previous session",
    );

    const latest = orphanedTasks[0];
    const older = orphanedTasks.slice(1);

    // Mark older orphans as failed immediately (task-watcher will notify)
    for (const task of older) {
      markTaskFailed(
        task.id,
        "Task was interrupted by a daemon restart and could not be recovered.",
      );
    }

    // Prompt user about the most recent orphaned task
    const ago = timeAgo(latest.startedAt);
    const desc =
      latest.description.length > 80
        ? latest.description.slice(0, 77) + "..."
        : latest.description;
    const promptMsg =
      `A background task was interrupted by a restart:\n\n` +
      `<b>${escapeHtml(desc)}</b>\n` +
      `Started: ${ago}\n\n` +
      `Would you like to retry this task?`;

    const keyboard = new InlineKeyboard()
      .text("Retry", `orphan:resume:${latest.id}`)
      .text("Dismiss", `orphan:dismiss:${latest.id}`);

    try {
      await bot.api.sendMessage(latest.chatId, promptMsg, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      log.info(
        { taskId: latest.id, chatId: latest.chatId },
        "Sent orphan recovery prompt to user",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { taskId: latest.id, err: msg },
        "Failed to send orphan prompt",
      );
      // If we can't reach the user, mark it failed
      markTaskFailed(latest.id, "Task was interrupted by a daemon restart.");
    }
  }

  // Handle orphan recovery and failed message callback queries
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // --- Orphan recovery ---
    if (data.startsWith("orphan:")) {
      const [, action, taskId] = data.split(":");
      if (!action || !taskId) return;

      if (action === "resume") {
        const tasks = getActiveTasks();
        const task = tasks.find((t) => t.id === taskId);
        if (task) {
          queue.add(Number(task.chatId), task.description);
          dismissActiveTask(taskId);
          await ctx.answerCallbackQuery({ text: "Task re-queued" });
          await ctx.editMessageText(
            `Retrying: ${task.description.length > 60 ? task.description.slice(0, 57) + "..." : task.description}`,
          );
          log.info({ taskId }, "User chose to retry orphaned task");
        } else {
          await ctx.answerCallbackQuery({ text: "Task no longer exists" });
        }
      } else if (action === "dismiss") {
        dismissActiveTask(taskId);
        await ctx.answerCallbackQuery({ text: "Task dismissed" });
        await ctx.editMessageText("Dismissed orphaned task.");
        log.info({ taskId }, "User dismissed orphaned task");
      }
      return;
    }

    // --- Conflict resolution ---
    if (data.startsWith("conflict:")) {
      const [, action, pendingId] = data.split(":");
      if (!action || !pendingId || !rescueMonitor) return;

      if (action === "replace") {
        rescueMonitor.resolveConflict(pendingId, "replace");
        await ctx.answerCallbackQuery({ text: "Replacing existing task" });
        await ctx.editMessageText("Replaced existing task with the new one.");
        log.info({ pendingId }, "User chose to replace existing process");
      } else if (action === "cancel") {
        rescueMonitor.resolveConflict(pendingId, "cancel");
        await ctx.answerCallbackQuery({ text: "New task cancelled" });
        await ctx.editMessageText("Cancelled the new task.");
        log.info({ pendingId }, "User cancelled pending process");
      }
      return;
    }

    // --- Failed message retry ---
    if (data.startsWith("failed:")) {
      const [, action, retryId] = data.split(":");
      if (!action || !retryId) return;

      if (action === "retry") {
        const entry = failedMessages.get(retryId);
        if (entry) {
          queue.add(entry.chatId, entry.text, undefined, entry.threading);
          failedMessages.delete(retryId);
          await ctx.answerCallbackQuery({ text: "Message re-queued" });
          const desc =
            entry.text.length > 60
              ? entry.text.slice(0, 57) + "..."
              : entry.text;
          await ctx.editMessageText(`Retrying: ${desc}`);
          log.info(
            { retryId, chatId: entry.chatId },
            "User retried failed message",
          );
        } else {
          await ctx.answerCallbackQuery({
            text: "Retry expired — please resend your message",
          });
        }
      } else if (action === "dismiss") {
        failedMessages.delete(retryId);
        await ctx.answerCallbackQuery({ text: "Dismissed" });
        await ctx.editMessageText("Dismissed.");
        log.info({ retryId }, "User dismissed failed message");
      }
      return;
    }
  });

  // Initialize rescue monitor for batch path timeout recovery
  const rescueConfig = getJsonConfig().rescue ?? {
    enabled: true,
    thresholdMs: 75000,
    safetyTimeoutMs: 600000,
    inactivityTimeoutMs: 600000,
    maxConcurrent: 1,
    updateIntervalMs: 30000,
  };

  if (rescueConfig.enabled) {
    const rescueCallbacks: RescueMonitorCallbacks = {
      sendMessage: async (chatId, text, opts) => {
        try {
          await bot.api.sendMessage(chatId, text, {
            parse_mode: opts?.parseMode as "HTML" | undefined,
            message_thread_id: opts?.messageThreadId,
          });
        } catch {
          // HTML parse failed — strip tags and send as plain text
          try {
            await bot.api.sendMessage(chatId, text.replace(/<[^>]*>/g, ""), {
              message_thread_id: opts?.messageThreadId,
            });
          } catch {
            // Give up silently
          }
        }
      },
      onComplete: async (chatId, response, model) => {
        // Run same post-hooks as normal completion
        const backgroundAgentsEnabled =
          getJsonConfig().subagents?.enabled ?? true;
        if (backgroundAgentsEnabled) {
          maybeSpawnBackgroundAgent(
            response.toolUse,
            response.session_id,
            chatId,
            model,
          );
        }
        invalidateIdentityCache();
        const committed = await autoCommitChanges();
        if (committed) {
          log.info("Auto-committed changes from rescued process");
        }
      },
      onFailure: async (chatId, originalMessage, reason, opts) => {
        try {
          await sendRetryKeyboard(chatId, originalMessage, reason, opts);
        } catch (err) {
          log.error({ err, chatId }, "Failed to send retry keyboard");
        }
      },
      onConflict: async (
        chatId,
        existingDesc,
        existingType,
        newDesc,
        pendingId,
      ) => {
        const truncExisting =
          existingDesc.length > 60
            ? existingDesc.slice(0, 57) + "..."
            : existingDesc;
        const truncNew =
          newDesc.length > 60 ? newDesc.slice(0, 57) + "..." : newDesc;
        const msg =
          `A task is already running:\n` +
          `[${existingType}] "${escapeHtml(truncExisting)}"\n\n` +
          `New task waiting: "${escapeHtml(truncNew)}"`;
        const keyboard = new InlineKeyboard()
          .text("Replace existing", `conflict:replace:${pendingId}`)
          .text("Cancel new task", `conflict:cancel:${pendingId}`);
        await bot.api.sendMessage(chatId, msg, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      },
    };

    rescueMonitor = new RescueMonitor(rescueCallbacks, {
      maxConcurrent: rescueConfig.maxConcurrent,
      updateIntervalMs: rescueConfig.updateIntervalMs,
      safetyTimeoutMs: rescueConfig.safetyTimeoutMs,
    });
    log.info(
      {
        thresholdMs: rescueConfig.thresholdMs,
        safetyTimeoutMs: rescueConfig.safetyTimeoutMs,
      },
      "Rescue monitor initialized",
    );
  }

  // Register skill commands in Telegram menu
  await registerSkillCommands(bot);
  log.info({ skills: getInstalledSkillNames() }, "Registered skill commands");

  // Initialize data directory and components
  ensureDataDir(KLAUSBOT_HOME);
  queue = new MessageQueue(KLAUSBOT_HOME);
  initPairingStore(KLAUSBOT_HOME);

  // Log startup stats
  const stats = queue.getStats();
  const pairingStore = getPairingStore();
  const approvedCount = pairingStore.listApproved().length;
  const pendingCount = pairingStore.listPending().length;

  log.info(
    {
      pending: stats.pending,
      failed: stats.failed,
      approvedUsers: approvedCount,
      pendingPairings: pendingCount,
    },
    "Gateway initialized",
  );

  // Setup middleware - ORDER MATTERS
  // 1. Pairing middleware first (blocks unapproved)
  bot.use(createPairingMiddleware());

  // 2. Commands
  bot.command("start", handleStartCommand);

  bot.command("model", async (ctx: MyContext) => {
    await ctx.reply(
      "Current model: default\nModel switching coming in Phase 2",
    );
  });

  bot.command("status", async (ctx: MyContext) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const queueStats = queue.getStats();
    const store = getPairingStore();
    const isApproved = store.isApproved(chatId);

    // Get active/orphaned background tasks (latest 5)
    const activeTasks = getActiveTasks()
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
      .slice(0, 5);

    const lines = [
      "*Queue Status*",
      `Pending: ${queueStats.pending}`,
      `Processing: ${queueStats.processing}`,
      `Failed: ${queueStats.failed}`,
    ];

    if (activeTasks.length > 0) {
      lines.push("", `*Background Tasks* (${activeTasks.length} active)`);
      for (const task of activeTasks) {
        const ago = timeAgo(task.startedAt);
        const desc =
          task.description.length > 60
            ? task.description.slice(0, 57) + "..."
            : task.description;
        lines.push(`• ${desc} (${ago})`);
      }
    }

    lines.push("", `*Your Status*`, `Approved: ${isApproved ? "Yes" : "No"}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx: MyContext) => {
    const helpMsg = [
      "*Available Commands*",
      "/start - Request pairing or check status",
      "/status - Show queue and approval status",
      "/model - Show current model info",
      "/crons - List scheduled tasks",
      "/help - Show this help message",
      "",
      "Send any message to chat with Claude.",
    ].join("\n");

    await ctx.reply(helpMsg, { parse_mode: "Markdown" });
  });

  // 3. Message handler
  bot.on("message:text", async (ctx: MyContext) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const rawText = ctx.message?.text ?? "";

    // Skip empty messages
    if (!rawText.trim()) return;

    // Translate skill commands: /skill_creator → /skill skill-creator
    const text = translateSkillCommand(rawText);

    // Extract threading context for forum topics and reply linking
    const threading: ThreadingContext = {
      messageThreadId: ctx.msg?.message_thread_id,
      replyToMessageId: ctx.msg?.message_id,
    };

    // Add to queue - typing indicator shown by autoChatAction middleware
    const queueId = queue.add(chatId, text, undefined, threading);
    log.info(
      { chatId, queueId, translated: text !== rawText },
      "Message queued",
    );

    // Trigger processing (non-blocking)
    processQueue().catch((err) => {
      log.error({ err }, "Queue processing error");
    });
  });

  // Voice message handler
  bot.on("message:voice", async (ctx: MyContext) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const voice = ctx.message?.voice;
    if (!voice) return;

    log.info(
      { chatId, fileId: voice.file_id, duration: voice.duration },
      "Received voice message",
    );

    // Download voice file to temp location
    const tempPath = path.join(os.tmpdir(), `klausbot-voice-${Date.now()}.ogg`);

    try {
      await downloadFile(bot, voice.file_id, tempPath);

      const media: MediaAttachment[] = [
        {
          type: "voice",
          fileId: voice.file_id,
          localPath: tempPath,
          mimeType: voice.mime_type,
        },
      ];

      // Voice messages don't have captions in Telegram
      const text = "";

      // Extract threading context for forum topics and reply linking
      const threading: ThreadingContext = {
        messageThreadId: ctx.msg?.message_thread_id,
        replyToMessageId: ctx.msg?.message_id,
      };

      const queueId = queue.add(chatId, text, media, threading);
      log.info({ chatId, queueId, mediaCount: 1 }, "Voice message queued");

      processQueue().catch((err) => {
        log.error({ err }, "Queue processing error");
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, chatId }, "Failed to download voice message");
      await ctx.reply(`Failed to process voice message: ${msg}`);
    }
  });

  // Photo message handler
  bot.on("message:photo", async (ctx: MyContext) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Get largest photo (last in array)
    const largest = photos[photos.length - 1];

    log.info(
      {
        chatId,
        fileId: largest.file_id,
        width: largest.width,
        height: largest.height,
      },
      "Received photo message",
    );

    // Download photo to temp location
    const tempPath = path.join(os.tmpdir(), `klausbot-photo-${Date.now()}.jpg`);

    try {
      await downloadFile(bot, largest.file_id, tempPath);

      const media: MediaAttachment[] = [
        {
          type: "photo",
          fileId: largest.file_id,
          localPath: tempPath,
        },
      ];

      // Get caption if any
      const text = ctx.message?.caption ?? "";

      // Extract threading context for forum topics and reply linking
      const threading: ThreadingContext = {
        messageThreadId: ctx.msg?.message_thread_id,
        replyToMessageId: ctx.msg?.message_id,
      };

      const queueId = queue.add(chatId, text, media, threading);
      log.info(
        { chatId, queueId, mediaCount: 1, hasCaption: !!text },
        "Photo message queued",
      );

      processQueue().catch((err) => {
        log.error({ err }, "Queue processing error");
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, chatId }, "Failed to download photo");
      await ctx.reply(`Failed to process photo: ${msg}`);
    }
  });

  // Media group handler (multiple photos in one message)
  // Note: grammY fires message:photo for each photo in a media group
  // We handle them individually - they'll be queued separately
  // Future enhancement: collect media groups using message.media_group_id

  // Catch-all for unsupported message types
  bot.on("message", async (ctx: MyContext) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const msg = ctx.message ?? {};
    const messageKeys = Object.keys(msg);

    // Silently ignore service messages (topic created/edited/closed, pinned, etc.)
    const serviceKeys = [
      "forum_topic_created",
      "forum_topic_edited",
      "forum_topic_closed",
      "forum_topic_reopened",
      "general_forum_topic_hidden",
      "general_forum_topic_unhidden",
      "pinned_message",
      "new_chat_members",
      "left_chat_member",
      "new_chat_title",
      "new_chat_photo",
      "delete_chat_photo",
      "group_chat_created",
      "supergroup_chat_created",
      "channel_chat_created",
      "migrate_to_chat_id",
      "migrate_from_chat_id",
      "message_auto_delete_timer_changed",
      "is_topic_message",
    ];
    if (messageKeys.some((key) => serviceKeys.includes(key))) return;

    const messageType = messageKeys.find(
      (key) =>
        ![
          "message_id",
          "from",
          "chat",
          "date",
          "text",
          "voice",
          "photo",
          "caption",
          "entities",
          "message_thread_id",
          "is_topic_message",
          "reply_to_message",
        ].includes(key),
    );

    log.info({ chatId, messageType }, "Received unsupported message type");

    await ctx.reply(
      "I can process text, voice messages, and photos. Other message types are not yet supported.",
    );
  });

  // Start processing loop in background
  processQueue().catch((err) => {
    log.error({ err }, "Initial queue processing error");
  });

  // Create runner
  const runner = createRunner();
  log.info("Gateway running");

  // Set up shutdown handlers
  const shutdown = async () => {
    log.info("Shutdown signal received");
    await stopGateway();
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for runner to stop (blocks until shutdown signal)
  await runner.task();
}

/**
 * Stop the gateway gracefully
 */
export async function stopGateway(): Promise<void> {
  log.info("Stopping gateway...");
  shouldStop = true;

  // Stop cron scheduler
  stopScheduler();

  // Stop heartbeat scheduler
  stopHeartbeat();

  // Stop background task watcher
  if (stopTaskWatcher) {
    stopTaskWatcher();
    stopTaskWatcher = null;
  }

  // Stop rescue monitor
  if (rescueMonitor) {
    rescueMonitor.shutdown();
    rescueMonitor = null;
  }

  // Close database connection
  closeDb();

  // Wait for current processing to finish (max 30s)
  const timeout = 30000;
  const start = Date.now();
  while (isProcessing && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isProcessing) {
    log.warn("Timed out waiting for processing to complete");
  }

  log.info("Gateway stopped");
}

/**
 * Summarize tool-use entries for retry context.
 * e.g. "Wrote to USER.md, Called search_memories"
 */
function summarizeToolUse(toolUse: ToolUseEntry[]): string {
  return toolUse
    .map((t) => {
      // Extract meaningful context from common tools
      if (t.name === "Write" || t.name === "Edit") {
        const filePath = (t.input.file_path as string) ?? "a file";
        const fileName = filePath.split("/").pop() ?? filePath;
        return `Updated ${fileName}`;
      }
      if (t.name === "Read") {
        const filePath = (t.input.file_path as string) ?? "a file";
        const fileName = filePath.split("/").pop() ?? filePath;
        return `Read ${fileName}`;
      }
      return `Used ${t.name}`;
    })
    .join(", ");
}

/**
 * Retry with Claude when primary call returned empty text but performed tool-use.
 * Passes tool-use context so Claude can acknowledge what it did naturally.
 * Uses short timeout and no additional instructions to minimize tool-use risk.
 */
async function retryWithToolContext(
  originalPrompt: string,
  toolUse: ToolUseEntry[],
  model?: string,
): Promise<string | null> {
  const summary = summarizeToolUse(toolUse);
  log.warn(
    { toolUseSummary: summary },
    "Empty response, retrying with tool-use context",
  );

  try {
    const nudge =
      `You just handled a user message and performed these actions: ${summary}\n` +
      `But you forgot to reply with text. The user said: "${originalPrompt}"\n\n` +
      `Now respond naturally in 1-2 sentences acknowledging what you did. Be casual and warm.`;

    const retry = await queryClaudeCode(nudge, {
      model,
      timeout: 15000,
    });
    if (retry.result) {
      log.info({ resultLength: retry.result.length }, "Retry produced text");
      return retry.result;
    }
  } catch (err) {
    log.error({ err }, "Retry failed");
  }
  return null;
}

/**
 * Process messages from queue
 * Runs as background loop
 */
async function processQueue(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) return;
  isProcessing = true;

  while (!shouldStop) {
    const msg = queue.take();

    if (!msg) {
      // No messages, wait and try again
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    await processMessage(msg);
  }

  isProcessing = false;
}

/**
 * Process a single queued message
 */
async function processMessage(msg: QueuedMessage): Promise<void> {
  lastActiveChatId = msg.chatId;
  const startTime = Date.now();

  // Send typing indicator continuously while processing
  // Telegram typing indicator lasts ~5 seconds, so refresh every 4
  const sendTyping = () => {
    bot.api.sendChatAction(msg.chatId, "typing").catch(() => {
      // Ignore errors - chat may be unavailable
    });
  };
  sendTyping(); // Send immediately
  const typingInterval = setInterval(sendTyping, 4000);

  try {
    // Process media attachments if present
    let effectiveText = msg.text;
    let mediaErrors: string[] = [];

    if (msg.media && msg.media.length > 0) {
      const { processed, errors } = await processMedia(msg.media);
      mediaErrors = errors;

      if (processed.length > 0) {
        effectiveText = buildPromptWithMedia(msg.text, processed);
      }
    }

    // If all media failed and no text, send error and return
    if (mediaErrors.length > 0 && !effectiveText.trim()) {
      clearInterval(typingInterval);
      queue.fail(msg.id, mediaErrors.join("; "));
      await bot.api.sendMessage(
        msg.chatId,
        `Could not process media: ${mediaErrors.join(". ")}`,
        {
          message_thread_id: msg.threading?.messageThreadId,
          reply_parameters: msg.threading?.replyToMessageId
            ? { message_id: msg.threading.replyToMessageId }
            : undefined,
        },
      );
      return;
    }

    // Check if bootstrap needed (BOOTSTRAP.md exists)
    const isBootstrap = needsBootstrap();
    if (isBootstrap) {
      log.info({ chatId: msg.chatId }, "Bootstrap mode: BOOTSTRAP.md present");
    }

    // Build additional instructions (skip everything during bootstrap — BOOTSTRAP.md is the system prompt)
    let additionalInstructions = "";
    const jsonConfig = getJsonConfig();
    const backgroundAgentsEnabled =
      !isBootstrap && (jsonConfig.subagents?.enabled ?? true);

    if (!isBootstrap) {
      // Chat ID context for cron and background tasks
      const chatIdContext = `<session-context>
Current chat ID: ${msg.chatId}
Use this chatId when creating cron jobs or background tasks.
</session-context>`;

      // Conversation history injection
      let conversationContext = "";
      try {
        conversationContext = buildConversationContext(msg.chatId);
        if (conversationContext) {
          log.debug(
            { chatId: msg.chatId, contextLength: conversationContext.length },
            "Injected conversation context",
          );
        }
      } catch (err) {
        log.warn(
          { err, chatId: msg.chatId },
          "Failed to build conversation context",
        );
        // Non-fatal: continue without history
      }

      // Heartbeat note collection
      let noteInstructions = "";
      if (shouldCollectNote(effectiveText)) {
        noteInstructions =
          "\n\n" + getNoteCollectionInstructions(effectiveText);
        log.info({ chatId: msg.chatId }, "Heartbeat note collection triggered");
      }

      // Background agent orchestration
      let orchestrationInstructions = "";
      if (backgroundAgentsEnabled) {
        orchestrationInstructions = "\n\n" + getOrchestrationInstructions();
      }

      additionalInstructions =
        chatIdContext +
        conversationContext +
        noteInstructions +
        orchestrationInstructions;
    }

    // Check streaming
    const streamingEnabled =
      !isBootstrap && (jsonConfig.streaming?.enabled ?? true);
    const canStream =
      streamingEnabled && (await canStreamToChat(bot, msg.chatId));

    if (canStream) {
      // === STREAMING PATH ===
      log.info({ chatId: msg.chatId }, "Using streaming mode");

      try {
        const streamConfig: StreamConfig = jsonConfig.streaming ?? {
          enabled: true,
          throttleMs: 500,
        };

        // Build rescue options for streaming path
        const streamRescueConfig = jsonConfig.rescue;
        const useStreamRescue = rescueMonitor && streamRescueConfig?.enabled;

        let streamRescueHandle: RescueHandle | null = null;

        const streamResult = await streamToTelegram(
          bot,
          msg.chatId,
          effectiveText,
          streamConfig,
          {
            model: jsonConfig.model,
            additionalInstructions,
            messageThreadId: msg.threading?.messageThreadId,
            chatId: msg.chatId,
            replyToMessageId: msg.threading?.replyToMessageId,
            timeout: useStreamRescue
              ? streamRescueConfig.safetyTimeoutMs
              : undefined,
            inactivityTimeoutMs: useStreamRescue
              ? streamRescueConfig.inactivityTimeoutMs
              : undefined,
            rescueThresholdMs: useStreamRescue
              ? streamRescueConfig.thresholdMs
              : undefined,
            onRescue: useStreamRescue
              ? (handle: RescueHandle) => {
                  streamRescueHandle = handle;
                }
              : undefined,
          },
        );

        // Stop typing indicator
        clearInterval(typingInterval);

        // Handle rescued streaming response
        if (streamResult.rescued && streamRescueHandle && rescueMonitor) {
          queue.complete(msg.id);

          // Send partial text if streaming didn't already show it
          let sentText = "";
          if (!streamResult.messageSent && streamResult.result) {
            await splitAndSend(msg.chatId, streamResult.result, msg.threading);
            sentText = streamResult.result;
          } else if (streamResult.messageSent) {
            sentText = streamResult.result;
          }

          // Notify user
          await bot.api.sendMessage(
            msg.chatId,
            "<i>Still working on this directly (not a background task) \u2014 I'll send updates as I go.</i>",
            {
              parse_mode: "HTML",
              message_thread_id: msg.threading?.messageThreadId,
            },
          );

          // Register with rescue monitor
          rescueMonitor.registerOrPrompt(
            msg.id,
            streamRescueHandle,
            {
              chatId: msg.chatId,
              messageThreadId: msg.threading?.messageThreadId,
              sentText,
              originalMessage: effectiveText,
            },
            jsonConfig.model,
            effectiveText.slice(0, 100),
            "foreground",
          );

          const duration = Date.now() - startTime;
          log.info(
            {
              chatId: msg.chatId,
              queueId: msg.id,
              duration,
              rescued: true,
              streaming: true,
              partialLength: streamResult.result.length,
            },
            "Streaming message rescued, continuing in background",
          );

          // Invalidate + auto-commit + media errors still needed
          invalidateIdentityCache();
          if (mediaErrors.length > 0) {
            await bot.api.sendMessage(
              msg.chatId,
              `Note: Some media could not be processed: ${mediaErrors.join(". ")}`,
              { message_thread_id: msg.threading?.messageThreadId },
            );
          }
          const committed = await autoCommitChanges();
          if (committed) {
            log.info({ queueId: msg.id }, "Auto-committed Claude file changes");
          }

          return; // Exit — rescue monitor handles the rest
        }

        // Check for background task delegation
        if (backgroundAgentsEnabled) {
          maybeSpawnBackgroundAgent(
            streamResult.toolUse,
            streamResult.session_id,
            msg.chatId,
            jsonConfig.model,
          );
        }

        // Mark as complete
        queue.complete(msg.id);

        // Send final message — skip if streaming already delivered it
        if (streamResult.messageSent) {
          // Message already sent and formatted via editMessageText
        } else if (streamResult.result) {
          await splitAndSend(msg.chatId, streamResult.result, msg.threading);
        } else if (streamResult.toolUse && streamResult.toolUse.length > 0) {
          // Empty text but tool-use happened — retry with context
          const retryResult = await retryWithToolContext(
            effectiveText,
            streamResult.toolUse,
            jsonConfig.model,
          );
          if (retryResult) {
            await splitAndSend(msg.chatId, retryResult, msg.threading);
          } else {
            await bot.api.sendMessage(msg.chatId, "[Empty response]", {
              message_thread_id: msg.threading?.messageThreadId,
              reply_parameters: msg.threading?.replyToMessageId
                ? { message_id: msg.threading.replyToMessageId }
                : undefined,
            });
          }
        } else {
          await bot.api.sendMessage(msg.chatId, "[Empty response]", {
            message_thread_id: msg.threading?.messageThreadId,
            reply_parameters: msg.threading?.replyToMessageId
              ? { message_id: msg.threading.replyToMessageId }
              : undefined,
          });
        }

        // Invalidate identity cache
        invalidateIdentityCache();

        // Notify user of non-fatal media errors
        if (mediaErrors.length > 0) {
          await bot.api.sendMessage(
            msg.chatId,
            `Note: Some media could not be processed: ${mediaErrors.join(". ")}`,
            {
              message_thread_id: msg.threading?.messageThreadId,
            },
          );
        }

        const duration = Date.now() - startTime;
        log.info(
          {
            chatId: msg.chatId,
            queueId: msg.id,
            duration,
            cost: streamResult.cost_usd,
            streaming: true,
          },
          "Message processed (streaming)",
        );

        // Auto-commit
        const committed = await autoCommitChanges();
        if (committed) {
          log.info({ queueId: msg.id }, "Auto-committed Claude file changes");
        }

        return; // Exit early - streaming handled everything
      } catch (err) {
        // Streaming failed - fall through to batch mode
        log.warn(
          { err, chatId: msg.chatId },
          "Streaming failed, falling back to batch",
        );
      }
    }

    // === BATCH PATH (existing code) ===
    // Build rescue options if rescue monitor is active
    const rescueConfig = jsonConfig.rescue;
    const useRescue = rescueMonitor && rescueConfig?.enabled;

    let rescueHandle: RescueHandle | null = null;

    const response = await queryClaudeCode(effectiveText, {
      additionalInstructions,
      model: jsonConfig.model,
      chatId: msg.chatId,
      timeout: useRescue ? rescueConfig.safetyTimeoutMs : undefined,
      inactivityTimeoutMs: useRescue
        ? rescueConfig.inactivityTimeoutMs
        : undefined,
      rescueThresholdMs: useRescue ? rescueConfig.thresholdMs : undefined,
      onRescue: useRescue
        ? (handle: RescueHandle) => {
            rescueHandle = handle;
          }
        : undefined,
    });

    // Stop typing indicator
    clearInterval(typingInterval);

    // Handle rescued response — send partial, register with monitor, unblock queue
    if (response.rescued && rescueHandle && rescueMonitor) {
      queue.complete(msg.id);

      // Send partial text accumulated so far
      let sentText = "";
      if (response.result) {
        await splitAndSend(msg.chatId, response.result, msg.threading);
        sentText = response.result;
      }

      // Notify user that response is still being generated
      await bot.api.sendMessage(
        msg.chatId,
        "<i>Still working on this directly (not a background task) \u2014 I'll send updates as I go.</i>",
        {
          parse_mode: "HTML",
          message_thread_id: msg.threading?.messageThreadId,
        },
      );

      // Register with rescue monitor for continued tracking
      rescueMonitor.registerOrPrompt(
        msg.id,
        rescueHandle,
        {
          chatId: msg.chatId,
          messageThreadId: msg.threading?.messageThreadId,
          sentText,
          originalMessage: effectiveText,
        },
        jsonConfig.model,
        effectiveText.slice(0, 100),
        "foreground",
      );

      const duration = Date.now() - startTime;
      log.info(
        {
          chatId: msg.chatId,
          queueId: msg.id,
          duration,
          rescued: true,
          partialLength: response.result.length,
        },
        "Message rescued, continuing in background",
      );
      return;
    }

    // Check for background task delegation
    if (backgroundAgentsEnabled) {
      maybeSpawnBackgroundAgent(
        response.toolUse,
        response.session_id,
        msg.chatId,
        jsonConfig.model,
      );
    }

    // Mark as complete
    queue.complete(msg.id);

    // Send response (handles splitting for long messages)
    if (response.is_error) {
      await bot.api.sendMessage(
        msg.chatId,
        `Error (Claude): ${response.result}`,
        {
          message_thread_id: msg.threading?.messageThreadId,
          reply_parameters: msg.threading?.replyToMessageId
            ? { message_id: msg.threading.replyToMessageId }
            : undefined,
        },
      );
    } else {
      // Invalidate identity cache after Claude response
      // Claude may have updated identity files during session
      invalidateIdentityCache();

      if (response.result) {
        const messages = await splitAndSend(
          msg.chatId,
          response.result,
          msg.threading,
        );
        log.debug(
          { chatId: msg.chatId, chunks: messages },
          "Sent response chunks",
        );
      } else if (response.toolUse && response.toolUse.length > 0) {
        // Empty text but tool-use happened — retry with context
        const retryResult = await retryWithToolContext(
          effectiveText,
          response.toolUse,
          jsonConfig.model,
        );
        if (retryResult) {
          await splitAndSend(msg.chatId, retryResult, msg.threading);
        } else {
          await bot.api.sendMessage(msg.chatId, "[Empty response]", {
            message_thread_id: msg.threading?.messageThreadId,
            reply_parameters: msg.threading?.replyToMessageId
              ? { message_id: msg.threading.replyToMessageId }
              : undefined,
          });
        }
      } else {
        await bot.api.sendMessage(msg.chatId, "[Empty response]", {
          message_thread_id: msg.threading?.messageThreadId,
          reply_parameters: msg.threading?.replyToMessageId
            ? { message_id: msg.threading.replyToMessageId }
            : undefined,
        });
      }

      // Notify user of non-fatal media errors
      if (mediaErrors.length > 0) {
        await bot.api.sendMessage(
          msg.chatId,
          `Note: Some media could not be processed: ${mediaErrors.join(". ")}`,
          {
            message_thread_id: msg.threading?.messageThreadId,
          },
        );
      }
    }

    const duration = Date.now() - startTime;
    log.info(
      {
        chatId: msg.chatId,
        queueId: msg.id,
        duration,
        cost: response.cost_usd,
      },
      "Message processed",
    );

    // Auto-commit any file changes Claude made
    const committed = await autoCommitChanges();
    if (committed) {
      log.info({ queueId: msg.id }, "Auto-committed Claude file changes");
    }
  } catch (err) {
    // Stop typing indicator
    clearInterval(typingInterval);

    // Determine error category
    const error = err instanceof Error ? err : new Error(String(err));
    const category = categorizeError(error);
    const userMessage = `Error (${category}): ${getBriefDescription(error)}`;

    // Send error to user — fall back to retry keyboard if send fails
    try {
      await bot.api.sendMessage(msg.chatId, userMessage, {
        message_thread_id: msg.threading?.messageThreadId,
        reply_parameters: msg.threading?.replyToMessageId
          ? { message_id: msg.threading.replyToMessageId }
          : undefined,
      });
    } catch {
      try {
        await sendRetryKeyboard(msg.chatId, msg.text, category, {
          messageThreadId: msg.threading?.messageThreadId,
        });
      } catch (retryErr) {
        log.error({ retryErr, chatId: msg.chatId }, "Cannot reach user at all");
      }
    }

    // Mark as failed
    queue.fail(msg.id, error.message);

    log.error(
      { chatId: msg.chatId, queueId: msg.id, error: error.message, category },
      "Message failed",
    );
  }
}

/**
 * Split and send a long message directly via bot API
 * Converts Markdown to Telegram HTML for proper formatting
 * First chunk replies to original message; subsequent chunks in same thread only
 */
async function splitAndSend(
  chatId: number,
  text: string,
  threading?: ThreadingContext,
): Promise<number> {
  const MAX_LENGTH = 4096;

  // Convert Markdown to Telegram HTML, then split
  const html = markdownToTelegramHtml(text);
  const chunks = splitTelegramMessage(html, MAX_LENGTH);

  // Send chunks with delay, using HTML parse mode
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        message_thread_id: threading?.messageThreadId,
        // Only reply to original message for first chunk
        reply_parameters:
          i === 0 && threading?.replyToMessageId
            ? { message_id: threading.replyToMessageId }
            : undefined,
      });
    } catch (err) {
      // If HTML parsing fails, fall back to plain text
      log.warn({ err, chatId }, "HTML parse failed, sending as plain text");
      await bot.api.sendMessage(chatId, text.slice(0, MAX_LENGTH), {
        message_thread_id: threading?.messageThreadId,
        reply_parameters:
          i === 0 && threading?.replyToMessageId
            ? { message_id: threading.replyToMessageId }
            : undefined,
      });
    }
    if (chunks.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return chunks.length;
}

/**
 * Categorize error for user-friendly display
 */
function categorizeError(error: Error): string {
  const msg = error.message.toLowerCase();

  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("spawn") || msg.includes("failed to start")) {
    return "spawn";
  }
  if (msg.includes("parse") || msg.includes("json")) {
    return "parse";
  }
  if (msg.includes("exit")) {
    return "process";
  }

  return "unknown";
}

/**
 * Get brief error description (no stack traces)
 */
function getBriefDescription(error: Error): string {
  const msg = error.message;

  // Truncate long messages
  if (msg.length > 200) {
    return msg.slice(0, 200) + "...";
  }

  return msg;
}
