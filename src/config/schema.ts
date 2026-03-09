import { z } from "zod";

/**
 * Environment variable schema for klausbot (secrets only)
 * Validates environment variables at startup
 */
export const envSchema = z
  .object({
    /** Telegram Bot Token from @BotFather (required) */
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),

    /** OpenAI API key for embeddings/fallback (optional) */
    OPENAI_API_KEY: z.string().optional(),

    /** Log level for pino logger */
    LOG_LEVEL: z
      .enum(["silent", "trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),

    /** Container mode flag (set by Dockerfile) */
    KLAUSBOT_CONTAINER: z.enum(["1"]).optional(),

    /** Claude Code OAuth token (required in container mode) */
    CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  })
  .refine(
    (data) => {
      // If in container mode, OAuth token is required
      if (data.KLAUSBOT_CONTAINER === "1") {
        return Boolean(data.CLAUDE_CODE_OAUTH_TOKEN);
      }
      return true;
    },
    {
      message:
        "CLAUDE_CODE_OAUTH_TOKEN is required in container mode (run `claude setup-token` to generate)",
      path: ["CLAUDE_CODE_OAUTH_TOKEN"],
    },
  );

/** Inferred environment config type */
export type EnvConfig = z.infer<typeof envSchema>;

/**
 * JSON config schema for klausbot (non-secrets)
 * Loaded from ~/.klausbot/config/klausbot.json
 * Uses strict mode - unknown keys cause validation failure
 *
 * Includes: model, streaming, heartbeat settings
 */
export const jsonConfigSchema = z
  .object({
    /** AI model to use for responses (opus, sonnet, haiku) */
    model: z.string().default("claude-opus-4-6"),
    /** Streaming configuration for real-time responses */
    streaming: z
      .object({
        /** Enable streaming mode (default: true) */
        enabled: z.boolean().default(true),
        /** Minimum interval between draft updates in ms (100-2000, default: 500) */
        throttleMs: z.number().min(100).max(2000).default(500),
      })
      .default({ enabled: true, throttleMs: 500 }),
    /** Heartbeat configuration for periodic awareness checks */
    heartbeat: z
      .object({
        /** Enable heartbeat checks (default: true) */
        enabled: z.boolean().default(true),
        /** Interval between checks in ms (min 60000, default 1800000 = 30 min) */
        intervalMs: z.number().min(60000).default(1800000),
        /** Explicit target chatId override (when unset, uses last active chat) */
        chatId: z.number().optional(),
      })
      .default({ enabled: true, intervalMs: 1800000 }),
    /** Background agent orchestration configuration */
    subagents: z
      .object({
        /** Enable background agent spawning (default: true) */
        enabled: z.boolean().default(true),
      })
      .default({ enabled: true }),
    /** Rumination configuration for autonomous strategic intelligence scanning */
    rumination: z
      .object({
        /** Enable rumination scanning (default: true) */
        enabled: z.boolean().default(true),
        /** Interval between scans in ms (min 1h, default 24h) */
        intervalMs: z.number().min(3600000).default(86400000),
        /** Explicit target chatId override */
        chatId: z.number().optional(),
        /** Maximum items per digest (1-20, default: 7) */
        maxDigestItems: z.number().min(1).max(20).default(7),
      })
      .default({ enabled: true, intervalMs: 86400000, maxDigestItems: 7 }),
    /** Rescue-on-timeout configuration for streaming and batch paths */
    rescue: z
      .object({
        /** Enable rescue mechanism (default: true) */
        enabled: z.boolean().default(true),
        /** Time before rescue triggers in ms (30s-120s, default: 75s) */
        thresholdMs: z.number().min(30000).max(120000).default(75000),
        /** Initial safety timeout if Claude produces NO output at all (120s-900s, default: 600s) */
        safetyTimeoutMs: z.number().min(120000).max(900000).default(600000),
        /** Inactivity timeout after first activity — kill only if silent this long (60s-7200s, default: 600s / 10 min) */
        inactivityTimeoutMs: z.number().min(60000).max(7200000).default(600000),
        /** Max concurrent rescued processes (0-3, default: 1) */
        maxConcurrent: z.number().min(0).max(3).default(1),
        /** Interval for sending progress updates in ms (10s-120s, default: 30s) */
        updateIntervalMs: z.number().min(10000).max(120000).default(30000),
      })
      .default({
        enabled: true,
        thresholdMs: 75000,
        safetyTimeoutMs: 600000,
        inactivityTimeoutMs: 600000,
        maxConcurrent: 1,
        updateIntervalMs: 30000,
      }),
  })
  .strict(); // Fail on unknown keys

/** Inferred JSON config type */
export type JsonConfig = z.infer<typeof jsonConfigSchema>;

// Backward compatibility - existing code uses configSchema
export const configSchema = envSchema;
export type Config = EnvConfig;
