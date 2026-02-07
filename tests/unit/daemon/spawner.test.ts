import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "fs";

// Mock logger and heavy dependencies to prevent side effects
vi.mock("../../../src/utils/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../../src/memory/index.js", () => ({
  KLAUSBOT_HOME: "/tmp/klausbot-test",
  buildSystemPrompt: vi.fn().mockReturnValue("test system prompt"),
}));

vi.mock("../../../src/daemon/transcript.js", () => ({
  handleTimeout: vi.fn().mockReturnValue(null),
}));

import {
  getMcpConfig,
  getHooksConfig,
  writeMcpConfigFile,
} from "../../../src/daemon/spawner.js";

describe("getMcpConfig", () => {
  it("returns object with mcpServers.klausbot key", () => {
    const config = getMcpConfig() as Record<string, unknown>;
    expect(config).toHaveProperty("mcpServers");
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("klausbot");
  });

  it("command is process.argv[0] (node executable)", () => {
    const config = getMcpConfig() as {
      mcpServers: { klausbot: { command: string } };
    };
    expect(config.mcpServers.klausbot.command).toBe(process.argv[0]);
  });

  it('args is [process.argv[1], "mcp"]', () => {
    const config = getMcpConfig() as {
      mcpServers: { klausbot: { args: string[] } };
    };
    expect(config.mcpServers.klausbot.args).toEqual([process.argv[1], "mcp"]);
  });

  it("env is an empty object", () => {
    const config = getMcpConfig() as {
      mcpServers: { klausbot: { env: object } };
    };
    expect(config.mcpServers.klausbot.env).toEqual({});
  });
});

describe("getHooksConfig", () => {
  it("returns object with hooks key", () => {
    const config = getHooksConfig() as Record<string, unknown>;
    expect(config).toHaveProperty("hooks");
  });

  it("has SessionStart, PreCompact, SessionEnd arrays", () => {
    const config = getHooksConfig() as {
      hooks: Record<string, unknown[]>;
    };
    expect(config.hooks).toHaveProperty("SessionStart");
    expect(config.hooks).toHaveProperty("PreCompact");
    expect(config.hooks).toHaveProperty("SessionEnd");
    expect(Array.isArray(config.hooks.SessionStart)).toBe(true);
    expect(Array.isArray(config.hooks.PreCompact)).toBe(true);
    expect(Array.isArray(config.hooks.SessionEnd)).toBe(true);
  });

  it('SessionStart matcher contains "startup|resume"', () => {
    const config = getHooksConfig() as {
      hooks: { SessionStart: Array<{ matcher: string }> };
    };
    expect(config.hooks.SessionStart[0].matcher).toContain("startup|resume");
  });

  it('each hook has type "command" and timeout number', () => {
    const config = getHooksConfig() as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ type: string; timeout: number }> }>
      >;
    };

    for (const key of ["SessionStart", "PreCompact", "SessionEnd"]) {
      const hookGroup = config.hooks[key][0];
      expect(hookGroup.hooks[0].type).toBe("command");
      expect(typeof hookGroup.hooks[0].timeout).toBe("number");
    }
  });

  it("hook commands contain process.argv[0] and process.argv[1]", () => {
    const config = getHooksConfig() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    for (const key of ["SessionStart", "PreCompact", "SessionEnd"]) {
      const command = config.hooks[key][0].hooks[0].command;
      expect(command).toContain(process.argv[0]);
      expect(command).toContain(process.argv[1]);
    }
  });
});

describe("writeMcpConfigFile", () => {
  let configPath: string | null = null;

  afterEach(() => {
    if (configPath && existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it('returns a path containing "klausbot-mcp" and process.pid', () => {
    configPath = writeMcpConfigFile();
    expect(configPath).toContain("klausbot-mcp");
    expect(configPath).toContain(String(process.pid));
  });

  it("file exists at the returned path", () => {
    configPath = writeMcpConfigFile();
    expect(existsSync(configPath)).toBe(true);
  });

  it("file content is valid JSON matching getMcpConfig() output", () => {
    configPath = writeMcpConfigFile();
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(getMcpConfig());
  });
});
