/**
 * Rumination executor — the brain of the strategic intelligence system.
 *
 * Phase 1: Build context packet (project briefs + past digests)
 * Phase 2: Check for pending digest from prior deferred delivery
 * Phase 3: Spawn Claude for web scanning, synthesis, and filtering
 * Phase 4: Deliver digest or defer if user is active
 */

import { queryClaudeCode } from "../daemon/spawner.js";
import { getLastMessageTimestamp } from "../daemon/gateway.js";
import { getJsonConfig } from "../config/index.js";
import { createChildLogger, markdownToTelegramHtml } from "../utils/index.js";
import { readAllBriefs, ensureBrief } from "./brief.js";
import {
  readRecentDigests,
  appendDigest,
  trimDigestLog,
  consumePendingDigest,
  writePendingDigest,
} from "./digest.js";
import { listProjects } from "../memory/project.js";

const log = createChildLogger("rumination");

/** Exact response that suppresses digest delivery */
const RUMINATION_OK = "RUMINATION_OK";

/** Timeout for rumination scan (10 minutes) */
const RUMINATION_TIMEOUT = 600000;

/** Idle threshold before delivering digest (30 minutes) */
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/** Result of rumination execution */
export interface RuminationResult {
  delivered: boolean;
  deferred: boolean;
  digest?: string;
  error?: string;
}

/**
 * Build the rumination prompt for Claude.
 * Includes all project briefs and recent digests for dedup.
 */
function buildRuminationPrompt(
  briefs: Array<{ project: string; content: string }>,
  recentDigests: string,
  maxItems: number,
): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  const briefsXml = briefs
    .map(
      (b) =>
        `<project name="${b.project}">\n${b.content.trim()}\n</project>`,
    )
    .join("\n\n");

  const digestSection = recentDigests
    ? `<past-digests note="Avoid repeating these findings. Build on them or find new angles.">\n${recentDigests}\n</past-digests>`
    : `<past-digests>No previous digests yet.</past-digests>`;

  return `<rumination-scan>
You are a strategic intelligence analyst working for a developer/entrepreneur. Your job is to scan the world and find signals that matter to their specific projects and capabilities.

Today: ${dateStr}

<project-briefs>
${briefsXml}
</project-briefs>

${digestSection}

## Your Mission

Search the web thoroughly for developments relevant to the projects above. Look for:

1. **IP & Patents** — New patents filed in relevant domains, IP acquisition opportunities
2. **Market Signals** — Competitor moves, market shifts, funding rounds, acquisitions in related spaces
3. **Customer Demand** — Forum discussions, social media, Stack Overflow questions showing unmet needs these projects could address
4. **Research Papers** — Recent arxiv/IEEE/ACM papers with techniques directly applicable to active challenges
5. **Government & Tenders** — RFPs, tenders, grants, regulatory changes (especially Indian govt portals like GeM, ISRO, DRDO, MeitY if relevant)
6. **Data Sources** — New public datasets, APIs, or data channels that could enhance these projects
7. **Product Opportunities** — Ways to package or sell capabilities these projects already have
8. **Novel Approaches** — New libraries, tools, or techniques that could solve current challenges better
9. **Similar Projects** — Open source or commercial projects worth studying or contributing to

## Search Strategy

For each project, derive 2-3 specific search queries from its brief and active challenges. Search broadly — don't just look at the obvious. Cross-pollinate: findings for one project might create opportunities for another.

## Quality Filter

For each finding, score internally:
- **Novelty** (1-5): Is this new information, not in past digests?
- **Relevance** (1-5): How directly does this connect to a specific project?
- **Actionability** (1-5): Can the user do something concrete with this?

Only include findings scoring **50+ out of 125** (novelty × relevance × actionability).

## Output Format

If you found noteworthy items, output a clean digest:

# Intelligence Digest — ${dateStr}

▸ **Headline** [project-name]
  2-3 sentence summary. What it means for the project. Concrete action suggestion.

▸ **Next headline** [project-name]
  ...

Maximum ${maxItems} items. Quality over quantity. If nothing passes the quality bar, respond with exactly "${RUMINATION_OK}".

Do NOT include boilerplate, greetings, or meta-commentary. Just the digest items.
</rumination-scan>`;
}

/**
 * Check if the user is currently idle (no messages for 30+ minutes).
 */
function isUserIdle(): boolean {
  const lastMsg = getLastMessageTimestamp();
  if (lastMsg === 0) return true; // No messages ever — safe to send
  return Date.now() - lastMsg >= IDLE_THRESHOLD_MS;
}

/**
 * Execute a rumination cycle.
 *
 * @param targetChatId - Telegram chat ID for digest delivery
 * @returns Result indicating delivery/deferral status
 */
export async function executeRumination(
  targetChatId: number,
): Promise<RuminationResult> {
  log.info("Starting rumination cycle");

  const config = getJsonConfig();
  const maxItems = config.rumination?.maxDigestItems ?? 7;

  // Phase 1: Check for pending digest from prior deferred delivery
  const pending = consumePendingDigest();
  if (pending) {
    log.info("Found pending digest from previous cycle");
    return deliverOrDefer(targetChatId, pending);
  }

  // Phase 2: Build context packet
  // Ensure all projects have briefs
  ensureBrief(null); // global
  for (const project of listProjects()) {
    ensureBrief(project);
  }

  const briefs = readAllBriefs();
  if (briefs.length === 0) {
    log.info("No project briefs found, skipping rumination");
    return { delivered: false, deferred: false };
  }

  const recentDigests = readRecentDigests(30);

  // Trim old digest entries periodically
  trimDigestLog(60);

  // Phase 3: Spawn Claude for scanning
  const prompt = buildRuminationPrompt(briefs, recentDigests, maxItems);

  log.info(
    {
      projectCount: briefs.length,
      projects: briefs.map((b) => b.project),
      hasHistory: !!recentDigests,
    },
    "Scanning for strategic intelligence",
  );

  try {
    const response = await queryClaudeCode(prompt, {
      timeout: RUMINATION_TIMEOUT,
      inactivityTimeoutMs: 120000,
    });

    const result = response.result.trim();

    if (result === RUMINATION_OK) {
      log.info("Rumination complete — nothing noteworthy found");
      return { delivered: false, deferred: false };
    }

    if (!result) {
      log.warn("Rumination returned empty response");
      return { delivered: false, deferred: false };
    }

    log.info(
      {
        digestLength: result.length,
        cost: response.cost_usd,
      },
      "Digest generated",
    );

    // Phase 4: Deliver or defer
    return deliverOrDefer(targetChatId, result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Rumination execution failed");
    return { delivered: false, deferred: false, error: errorMsg };
  }
}

/**
 * Deliver digest immediately if user is idle, otherwise defer to pending file.
 */
async function deliverOrDefer(
  targetChatId: number,
  digest: string,
): Promise<RuminationResult> {
  if (isUserIdle()) {
    // Deliver now
    try {
      const { bot } = await import("../telegram/index.js");
      const html = markdownToTelegramHtml(digest);

      // Split if needed (digests can be long)
      const { splitTelegramMessage } = await import("../utils/index.js");
      const chunks = splitTelegramMessage(html, 4096);

      for (const chunk of chunks) {
        try {
          await bot.api.sendMessage(targetChatId, chunk, {
            parse_mode: "HTML",
          });
        } catch {
          // HTML failed, send plain
          await bot.api.sendMessage(targetChatId, chunk.replace(/<[^>]*>/g, ""));
        }
      }

      // Persist to digest log
      appendDigest(digest);

      log.info(
        { targetChatId, chunks: chunks.length },
        "Digest delivered to user",
      );
      return { delivered: true, deferred: false, digest };
    } catch (err) {
      log.error({ err, targetChatId }, "Failed to deliver digest");
      // Save as pending so we retry next tick
      writePendingDigest(digest);
      return { delivered: false, deferred: true, digest };
    }
  } else {
    // User is active — defer delivery
    writePendingDigest(digest);
    log.info("User is active, deferring digest delivery");
    return { delivered: false, deferred: true, digest };
  }
}
