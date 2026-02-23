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
  /** Text length at last update */
  lastSentLength: number;
  /** Interval timer for periodic updates */
  intervalId: ReturnType<typeof setInterval>;
  /** Safety kill timer */
  safetyTimerId: ReturnType<typeof setTimeout>;
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
  private callbacks: RescueMonitorCallbacks;
  private config: RescueMonitorConfig;

  constructor(callbacks: RescueMonitorCallbacks, config: RescueMonitorConfig) {
    this.callbacks = callbacks;
    this.config = config;
  }

  /** Register a rescued process for monitoring */
  register(
    id: string,
    handle: RescuedProcess,
    context: RescueContext,
    model?: string,
  ): void {
    // Evict oldest if at capacity
    if (this.tracked.size >= this.config.maxConcurrent) {
      const oldest = this.tracked.keys().next().value!;
      log.warn(
        { evictedId: oldest, newId: id },
        "Evicting oldest rescued process",
      );
      this.evict(oldest, "Replaced by newer request");
    }

    const lastSentLength = context.sentText.length;

    // Periodic progress updates
    const intervalId = setInterval(() => {
      this.sendDelta(id).catch((err) => {
        log.warn({ err, id }, "Failed to send rescue delta");
      });
    }, this.config.updateIntervalMs);

    // Safety kill timer
    const safetyTimerId = setTimeout(() => {
      log.warn({ id }, "Safety timeout reached, killing rescued process");
      this.evict(id, "Safety timeout reached");
    }, this.config.safetyTimeoutMs);

    const tracked: TrackedProcess = {
      id,
      handle,
      context,
      model,
      lastSentLength,
      intervalId,
      safetyTimerId,
    };

    this.tracked.set(id, tracked);

    // Watch for completion
    handle.completion
      .then((response) => this.handleCompletion(id, response))
      .catch((err) => {
        log.error({ err, id }, "Rescued process completion error");
        this.cleanup(id);
      });

    log.info(
      { id, chatId: context.chatId, tracked: this.tracked.size },
      "Registered rescued process",
    );
  }

  /** Send new text delta to user */
  private async sendDelta(id: string): Promise<void> {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    const current = tracked.handle.getAccumulated();
    if (current.length <= tracked.lastSentLength) return;

    const delta = current.slice(tracked.lastSentLength);
    if (!delta.trim()) return;

    // Send delta as a new message (continuation)
    try {
      await this.callbacks.sendMessage(
        tracked.context.chatId,
        delta.slice(0, 4096),
        { messageThreadId: tracked.context.messageThreadId },
      );
      tracked.lastSentLength = current.length;
      log.debug({ id, deltaLength: delta.length }, "Sent rescue delta");
    } catch (err) {
      log.warn({ err, id }, "Failed to send rescue delta message");
    }
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

  /** Evict a tracked process — kill and notify user */
  private evict(id: string, reason: string): void {
    const tracked = this.tracked.get(id);
    if (!tracked) return;

    tracked.handle.kill();

    this.callbacks
      .sendMessage(tracked.context.chatId, `[${reason}]`, {
        messageThreadId: tracked.context.messageThreadId,
      })
      .catch(() => {});

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
    log.info("Rescue monitor shut down");
  }

  /** Number of currently tracked processes */
  get size(): number {
    return this.tracked.size;
  }
}
