import { describe, expect, it } from "vitest";
import { envSchema, jsonConfigSchema } from "../../../src/config/schema.js";

describe("envSchema", () => {
  it("succeeds with valid TELEGRAM_BOT_TOKEN and defaults LOG_LEVEL to 'info'", () => {
    const result = envSchema.safeParse({ TELEGRAM_BOT_TOKEN: "123:ABC" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.LOG_LEVEL).toBe("info");
      expect(result.data.TELEGRAM_BOT_TOKEN).toBe("123:ABC");
    }
  });

  it("fails when TELEGRAM_BOT_TOKEN is missing", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("fails when TELEGRAM_BOT_TOKEN is empty string", () => {
    const result = envSchema.safeParse({ TELEGRAM_BOT_TOKEN: "" });
    expect(result.success).toBe(false);
  });

  it("fails in container mode without OAuth token (refinement)", () => {
    const result = envSchema.safeParse({
      TELEGRAM_BOT_TOKEN: "x",
      KLAUSBOT_CONTAINER: "1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(
        (i: { message: string }) => i.message,
      );
      expect(
        messages.some((m: string) => m.includes("CLAUDE_CODE_OAUTH_TOKEN")),
      ).toBe(true);
    }
  });

  it("succeeds in container mode with OAuth token", () => {
    const result = envSchema.safeParse({
      TELEGRAM_BOT_TOKEN: "x",
      KLAUSBOT_CONTAINER: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(result.success).toBe(true);
  });

  it("fails with invalid LOG_LEVEL", () => {
    const result = envSchema.safeParse({
      TELEGRAM_BOT_TOKEN: "x",
      LOG_LEVEL: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid LOG_LEVEL values", () => {
    const levels = [
      "silent",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ];
    for (const level of levels) {
      const result = envSchema.safeParse({
        TELEGRAM_BOT_TOKEN: "x",
        LOG_LEVEL: level,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts optional OPENAI_API_KEY", () => {
    const result = envSchema.safeParse({
      TELEGRAM_BOT_TOKEN: "x",
      OPENAI_API_KEY: "sk-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.OPENAI_API_KEY).toBe("sk-test");
    }
  });
});

describe("jsonConfigSchema", () => {
  it("applies all defaults for empty object", () => {
    const result = jsonConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude-opus-4-6");
      expect(result.data.streaming.enabled).toBe(true);
      expect(result.data.streaming.throttleMs).toBe(500);
      expect(result.data.heartbeat.enabled).toBe(true);
      expect(result.data.heartbeat.intervalMs).toBe(1_800_000);
      expect(result.data.subagents.enabled).toBe(true);
    }
  });

  it("allows partial override (model only)", () => {
    const result = jsonConfigSchema.safeParse({ model: "haiku" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("haiku");
      // Rest should be defaults
      expect(result.data.streaming.enabled).toBe(true);
      expect(result.data.heartbeat.enabled).toBe(true);
    }
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = jsonConfigSchema.safeParse({
      model: "haiku",
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects streaming throttleMs below 100", () => {
    const result = jsonConfigSchema.safeParse({
      streaming: { throttleMs: 50 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects streaming throttleMs above 2000", () => {
    const result = jsonConfigSchema.safeParse({
      streaming: { throttleMs: 3000 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects heartbeat intervalMs below 60000", () => {
    const result = jsonConfigSchema.safeParse({
      heartbeat: { intervalMs: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it("succeeds with full valid config", () => {
    const result = jsonConfigSchema.safeParse({
      model: "claude-sonnet-4-20250514",
      streaming: { enabled: false, throttleMs: 200 },
      heartbeat: { enabled: true, intervalMs: 120_000, chatId: 12345 },
      subagents: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude-sonnet-4-20250514");
      expect(result.data.streaming.enabled).toBe(false);
      expect(result.data.streaming.throttleMs).toBe(200);
      expect(result.data.heartbeat.chatId).toBe(12345);
      expect(result.data.subagents.enabled).toBe(false);
    }
  });

  it("accepts valid throttleMs at boundary (100)", () => {
    const result = jsonConfigSchema.safeParse({
      streaming: { throttleMs: 100 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid throttleMs at boundary (2000)", () => {
    const result = jsonConfigSchema.safeParse({
      streaming: { throttleMs: 2000 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid heartbeat intervalMs at boundary (60000)", () => {
    const result = jsonConfigSchema.safeParse({
      heartbeat: { intervalMs: 60_000 },
    });
    expect(result.success).toBe(true);
  });
});
