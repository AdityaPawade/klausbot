import { createChildLogger } from "../utils/index.js";
import type { ToolUseEntry, ClaudeResponse } from "./spawner.js";

const log = createChildLogger("rescue-monitor");

/** Handle for a rescued Claude process */
export interface RescuedProcess {
  /** Get accumulated text so far */
  getAccumulated: () => string;
  /** Resolves when process finishes (after rescue) */
  completion: Promise<ClaudeResponse>;
  /** Session ID (may be empty until process completes) */
  sessionId: string;
  /** Get tool-use entries collected so far */
  toolUseSoFar: () => ToolUseEntry[];
  /** Kill the process */
  kill: () => void;
}

/** Context needed to deliver rescued results */
export interface RescueContext {
  chatId: number;
  messageThreadId?: number;
  /** Text already sent to user at rescue time */
  sentText: string;
  /** Original user message text — used for retry on failure */
  originalMessage: string;
}

/** Callbacks for rescue monitor to interact with the system */
export interface RescueMonitorCallbacks {
  /** Send a message to a Telegram chat */
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { messageThreadId?: number; parseMode?: string },
  ) => Promise<void>;
  /** Post-completion hooks (background agent, auto-commit, cache invalidation) */
  onComplete: (
    chatId: number,
    response: ClaudeResponse,
    model?: string,
  ) => Promise<void>;
  /** Called when a rescued process fails — gateway sends retry keyboard */
  onFailure: (
    chatId: number,
    originalMessage: string,
    reason: string,
    opts?: { messageThreadId?: number },
  ) => Promise<void>;
  /** Called when at capacity and a new process wants to register */
  onConflict?: (
    chatId: number,
    existingDesc: string,
    existingType: string,
    newDesc: string,
    pendingId: string,
  ) => Promise<void>;
}

/** Configuration for rescue monitor */
export interface RescueMonitorConfig {
  /** Max concurrent rescued processes */
  maxConcurrent: number;
  /** Interval for sending progress updates in ms */
  updateIntervalMs: number;
  /** Hard safety timeout in ms */
  safetyTimeoutMs: number;
}

/** Tracked rescued process */
interface TrackedProcess {
  id: string;
  handle: RescuedProcess;
  context: RescueContext;
  model?: string;
  /** Human-readable description of the task */
  description: string;
  /** Whether this is a foreground rescue or background agent */
  type: "foreground" | "background";
  /** Text length at last update */
  lastSentLength: number;
  /** Tool count at last update (for activity reporting) */
  lastToolCount: number;
  /** Interval timer for periodic updates */
  intervalId: ReturnType<typeof setInterval>;
  /** Safety kill timer */
  safetyTimerId: ReturnType<typeof setTimeout>;
}

/** Pending registration waiting for user conflict resolution */
interface PendingRegistration {
  id: string;
  handle: RescuedProcess;
  context: RescueContext;
  model?: string;
  description: string;
  type: "foreground" | "background";
}

/**
 * Singleton that tracks rescued Claude processes.
 * After processMessage() returns early (rescue threshold), this monitor:
 * - Periodically sends new text deltas to Telegram
 * - On completion, sends remaining text and runs post-hooks
 * - Safety-kills processes that exceed the hard timeout
 */
export class RescueMonitor {
  private tracked = new Map<string, TrackedProcess>();
  private pendingRegistrations = new Map<string, PendingRegistration>();
  private callbacks: RescueMonitorCallbacks;
  private config: RescueMonitorConfig;

  constructor(callbacks: RescueMonitorCallbacks, config: RescueMonitorConfig) {
    this.callbacks = callbacks;
    this.config = config;
  }

  /**
   * Register if there's capacity, otherwise prompt user to resolve the conflict.
   * Returns true if registered immediately, false if pending user decision.
   */
  registerOrPrompt(
    id: string,
    handle: RescuedProcess,
    context: RescueContext,
    model: string | undefined,
    description: string,
    type: "foreground" | "background",
  ): boolean {
    if (this.tracked.size < this.config.maxConcurrent) {
      this.register(id, handle, context, model, description, type);
      return true;
    }

    // At capacity — store pending and notify via callback
    this.pendingRegistrations.set(id, {
      id,
      handle,
      context,
      model,
      description,
      type,
    });

    // Find the oldest tracked process for the conflict prompt
    const oldest = this.tracked.values().next().value!;

    if (this.callbacks.onConflict) {
      this.callbacks
        .onConflict(
          context.chatId,
          oldest.description,
          oldest.type,
          description,
          id,
        )
        .catch((err) => {
          log.error({ err, id }, "Failed to send conflict prompt");
        });
    } else {
      // No conflict callback — fall back to automatic eviction
      log.warn(
        { evictedId: oldest.id, newId: id },
        "Evicting oldest rescued process (no conflict callback)",
      );
      this.evict(oldest.id, "Replaced by newer request");
      this.pendingRegistrations.delete(id);
      this.register(id, handle, context, model, description, type);
      return true;
    }

    log.info(
      { pendingId: id, existingId: oldest.id, tracked: this.tracked.size },
      "Process pending conflict resolution",
    );
    return false;
  }

  /**
   * Resolve a pending conflict — either replace the oldest tracked process
   * or cancel the pending one.
   */
  resolveConflict(pendingId: string, action: "replace" | "cancel"): void {
    const pending = this.pendingRegistrations.get(pendingId);
    if (!pending) {
      log.warn({ pendingId }, "Conflict resolution for unknown pending ID");
      return;
    }

    this.pendingRegistrations.delete(pendingId);

    if (action === "replace") {
      // Evict the oldest tracked process
      const oldest = this.tracked.keys().next().value;
      if (oldest) {
        log.info(
          { evictedId: oldest, newId: pendingId },
          "User chose to replace existing process",
        );
        this.evict(oldest, "Replaced by user choice");
      }
      // Register the pending process
      this.register(
        pending.id,
        pending.handle,
        pending.context,
        pending.model,
        pending.description,
        pending.type,
      );
    } else {
      // Cancel the pending process
      log.info({ pendingId }, "User cancelled pending process");
      pending.handle.kill();
    }
  }

  /** Register a rescued process for monitoring */
  register(
    id: string,
    handle: RescuedProcess,
    context: RescueContext,
    model?: string,
    description?: string,
    type?: "foreground" | "background",
  ): void {
    const lastSentLength = context.sentText.length;

    // Periodic progress updates
    const intervalId = setInterval(() => {
      this.sendDelta(id).catch((err) => {
        log.warn({ err, id }, "Failed to send rescue delta");
      });
    }, this.config.updateIntervalMs);

    // Activity-based safety timer — resets whenever tool/text progress is detected
    const safetyTimerId = setTimeout(() => {
      log.warn({ id }, "Safety timeout reached, killing rescued process");
      this.evict(id, "Safety timeout reached");
    }, this.config.safetyTimeoutMs);

    const tracked: TrackedProcess = {
      id,
      handle,
      context,
      model,
      description: description ?? context.originalMessage.slice(0, 100),
      type: type ?? "foreground",
      lastSentLength,
      lastToolCount: handle.toolUseSoFar().length,
      intervalId,
      safetyTimerId,
    };

    this.tracked.set(id, tracked);

    // Watch for completion
    handle.completion
      .then((response) => this.handleCompletion(id, response))
      .catch(async (err) => {
        log.error({ err, id }, "Rescued process completion error");
        const t = this.tracked.get(id);
        if (t) {
          const reason =
            err instanceof Error ? err.message : "Process failed unexpectedly";
          try {
            await this.callbacks.onFailure(
              t.context.chatId,
              t.context.originalMessage,
              reason,
              { messageThreadId: t.context.messageThreadId },
            );
          } catch (failErr) {
            log.error({ failErr, id }, "Failed to send failure notification");
          }
        }
        this.cleanup(id);
      });

    log.info(
      {
        id,
        chatId: context.chatId,
        tracked: this.tracked.size,
        type: tracked.type,
      },
      "Registered rescued process",
    );
  }

  /** Reset the safety timer for a tracked process (called on detected activity) */
  private resetSafetyTimer(tracked: TrackedProcess): void {
    clearTimeout(tracked.safetyTimerId);
    tracked.safetyTimerId = setTimeout(() => {
      log.warn(
        { id: tracked.id },
        "Safety timeout reached, killing rescued process",
      );
      this.evict(tracked.id, "Safety timeout reached");
    }, this.config.safetyTimeoutMs);
  }

  /** Send new text delta or tool activity update to user */
  private async sendDelta(id: string): Promise<void> {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    const current = tracked.handle.getAccumulated();
    const hasNewText = current.length > tracked.lastSentLength;
    const tools = tracked.handle.toolUseSoFar();
    const hasNewTools = tools.length > tracked.lastToolCount;

    // Any progress (text or tools) resets the safety timer
    if (hasNewText || hasNewTools) {
      this.resetSafetyTimer(tracked);
    }

    if (hasNewText) {
      const delta = current.slice(tracked.lastSentLength);
      if (!delta.trim()) return;

      // Send text delta as a new message
      try {
        await this.callbacks.sendMessage(
          tracked.context.chatId,
          delta.slice(0, 4096),
          { messageThreadId: tracked.context.messageThreadId },
        );
        tracked.lastSentLength = current.length;
        tracked.lastToolCount = tools.length;
        log.debug({ id, deltaLength: delta.length }, "Sent rescue delta");
      } catch (err) {
        log.warn({ err, id }, "Failed to send rescue delta message");
      }
      return;
    }

    // No new text — check for tool activity
    const toolCount = tools.length;
    if (toolCount <= tracked.lastToolCount) return;

    // Summarize recent tool activity
    const recentTools = tools.slice(tracked.lastToolCount);
    const summary = this.summarizeToolActivity(recentTools, toolCount);
    tracked.lastToolCount = toolCount;

    try {
      await this.callbacks.sendMessage(
        tracked.context.chatId,
        `<i>${summary}</i>`,
        {
          messageThreadId: tracked.context.messageThreadId,
          parseMode: "HTML",
        },
      );
      log.debug(
        { id, toolCount, newTools: recentTools.length },
        "Sent tool activity update",
      );
    } catch (err) {
      log.warn({ err, id }, "Failed to send tool activity update");
    }
  }

  /** Summarize recent tool activity into a human-readable string */
  private summarizeToolActivity(
    recentTools: ToolUseEntry[],
    totalCount: number,
  ): string {
    // Count tool types
    const counts = new Map<string, number>();
    for (const tool of recentTools) {
      const name = this.friendlyToolName(tool.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    // Build summary like "read 3 files, executed 2 commands"
    const parts: string[] = [];
    for (const [name, count] of counts) {
      parts.push(`${name} ×${count}`);
    }

    const detail = parts.join(", ");
    return `Still working (${totalCount} tool calls so far: ${detail})`;
  }

  /** Map Claude tool names to friendly descriptions */
  private friendlyToolName(name: string): string {
    const map: Record<string, string> = {
      Read: "read file",
      Write: "write file",
      Edit: "edit file",
      Bash: "shell command",
      Glob: "file search",
      Grep: "text search",
      WebFetch: "web fetch",
      WebSearch: "web search",
      Task: "sub-agent",
      NotebookEdit: "notebook edit",
    };
    return map[name] ?? name;
  }

  /** Handle process completion — send remaining text and run post-hooks */
  private async handleCompletion(
    id: string,
    response: ClaudeResponse,
  ): Promise<void> {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    log.info(
      {
        id,
        resultLength: response.result.length,
        cost: response.cost_usd,
        sessionId: response.session_id,
      },
      "Rescued process completed",
    );

    // Send any remaining text
    const remaining = response.result.slice(tracked.lastSentLength);
    if (remaining.trim()) {
      try {
        await this.callbacks.sendMessage(
          tracked.context.chatId,
          remaining.slice(0, 4096),
          {
            messageThreadId: tracked.context.messageThreadId,
            parseMode: "HTML",
          },
        );
      } catch {
        // Try plain text fallback
        try {
          await this.callbacks.sendMessage(
            tracked.context.chatId,
            remaining.slice(0, 4096),
            { messageThreadId: tracked.context.messageThreadId },
          );
        } catch (err) {
          log.error({ err, id }, "Failed to send final rescue text");
        }
      }
    } else if (tracked.lastSentLength === 0 && !response.result.trim()) {
      // Nothing was ever sent to the user — offer retry
      log.warn({ id }, "Rescued process produced empty output");
      try {
        await this.callbacks.onFailure(
          tracked.context.chatId,
          tracked.context.originalMessage,
          "Process completed with no output",
          { messageThreadId: tracked.context.messageThreadId },
        );
      } catch (err) {
        log.error({ err, id }, "Failed to send failure notification");
      }
      this.cleanup(id);
      return;
    }

    // Run post-completion hooks
    try {
      await this.callbacks.onComplete(
        tracked.context.chatId,
        response,
        tracked.model,
      );
    } catch (err) {
      log.error({ err, id }, "Post-completion hooks failed");
    }

    this.cleanup(id);
  }

  /** Evict a tracked process — kill and offer retry */
  private evict(id: string, reason: string): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    tracked.handle.kill();

    this.callbacks
      .onFailure(
        tracked.context.chatId,
        tracked.context.originalMessage,
        reason,
        {
          messageThreadId: tracked.context.messageThreadId,
        },
      )
      .catch((err) => {
        log.error({ err, id }, "Failed to send eviction failure notification");
      });

    this.cleanup(id);
  }

  /** Clean up timers and remove from tracking */
  private cleanup(id: string): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    clearInterval(tracked.intervalId);
    clearTimeout(tracked.safetyTimerId);
    this.tracked.delete(id);

    log.debug(
      { id, remaining: this.tracked.size },
      "Cleaned up rescued process",
    );
  }

  /** Shut down all tracked processes */
  shutdown(): void {
    for (const [id] of this.tracked) {
      const tracked = this.tracked.get(id);
      if (tracked) {
        tracked.handle.kill();
        clearInterval(tracked.intervalId);
        clearTimeout(tracked.safetyTimerId);
      }
    }
    this.tracked.clear();

    // Kill any pending registrations too
    for (const [, pending] of this.pendingRegistrations) {
      pending.handle.kill();
    }
    this.pendingRegistrations.clear();

    log.info("Rescue monitor shut down");
  }

  /** Number of currently tracked processes */
  get size(): number {
    return this.tracked.size;
  }
}
