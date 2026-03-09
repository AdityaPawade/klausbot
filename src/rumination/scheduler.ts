/**
 * Rumination scheduler — periodic strategic intelligence scanning.
 * Mirrors the heartbeat scheduler pattern: configurable interval,
 * concurrent execution guard, hot-reload support, chat resolution.
 */

import { getJsonConfig } from "../config/index.js";
import { executeRumination } from "./executor.js";
import { getLastActiveChatId } from "../daemon/gateway.js";
import { getPairingStore } from "../pairing/index.js";
import { getMostRecentChatId } from "../memory/conversations.js";
import { createChildLogger } from "../utils/index.js";

const log = createChildLogger("rumination-scheduler");

let ruminationInterval: NodeJS.Timeout | null = null;
let isExecuting = false;

/**
 * Start the rumination scheduler.
 * Checks config.rumination.enabled before starting.
 * Does NOT run immediately — waits for first interval.
 */
export function startRumination(): void {
  if (ruminationInterval) {
    log.warn("Rumination already running");
    return;
  }

  const config = getJsonConfig();
  if (!config.rumination?.enabled) {
    log.info("Rumination disabled in config");
    return;
  }

  const intervalMs = config.rumination.intervalMs ?? 86400000;

  ruminationInterval = setInterval(tick, intervalMs);
  log.info({ intervalMs }, "Rumination scheduler started");
}

/**
 * Stop the rumination scheduler.
 */
export function stopRumination(): void {
  if (ruminationInterval) {
    clearInterval(ruminationInterval);
    ruminationInterval = null;
    log.info("Rumination scheduler stopped");
  }
}

/**
 * Manually trigger a rumination cycle (for /ruminate command).
 * Respects the concurrent execution guard.
 */
export async function triggerRumination(): Promise<void> {
  if (isExecuting) {
    log.info("Rumination already executing, skipping manual trigger");
    return;
  }

  const targetChatId = resolveTargetChat();
  if (targetChatId === null) {
    log.warn("No target chat for manual rumination trigger");
    return;
  }

  isExecuting = true;
  try {
    await executeRumination(targetChatId);
  } catch (err) {
    log.error({ err }, "Manual rumination trigger error");
  } finally {
    isExecuting = false;
  }
}

/**
 * Resolve target chat ID using cascade:
 * config override → last active → DB most recent → first approved
 */
function resolveTargetChat(): number | null {
  const config = getJsonConfig();
  return (
    config.rumination?.chatId ??
    getLastActiveChatId() ??
    getMostRecentChatId() ??
    getPairingStore().listApproved()[0]?.chatId ??
    null
  );
}

/**
 * Scheduler tick — execute rumination cycle.
 * Prevents concurrent execution, re-checks config for hot reload.
 */
async function tick(): Promise<void> {
  if (isExecuting) {
    log.debug("Rumination already executing, skipping tick");
    return;
  }

  // Re-check config (hot reload support)
  const config = getJsonConfig();
  if (!config.rumination?.enabled) {
    log.info("Rumination disabled via hot reload, stopping");
    stopRumination();
    return;
  }

  const targetChatId = resolveTargetChat();
  if (targetChatId === null) {
    log.warn(
      "No target chat for rumination (no config, no activity, no approved chats)",
    );
    return;
  }

  log.debug({ targetChatId }, "Resolved rumination target");

  isExecuting = true;
  try {
    await executeRumination(targetChatId);
  } catch (err) {
    log.error({ err }, "Rumination tick error");
  } finally {
    isExecuting = false;
  }
}
