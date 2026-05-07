/**
 * Unit tests for CodexBackend.
 *
 * Mocks child_process.spawn so we can drive the JSONL parser directly with
 * synthetic events. Covers:
 *  - Argv construction (model / sandbox / cwd / resume / reasoning effort)
 *  - Prompt wrapping (klausbot identity + user_message + reminder)
 *  - JSONL parsing (thread.started → session_id, item.completed agent_message,
 *    item.completed function_call → toolUse, error events)
 *  - health() — pass / fail / spawn error
 *  - Timeouts and non-zero exit handling
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

// Mock logger first to silence output during tests
vi.mock("../../../src/utils/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock memory/index to avoid pulling in DB / fs side effects
vi.mock("../../../src/memory/index.js", () => ({
  KLAUSBOT_HOME: "/tmp/klausbot-test",
}));

// Mock child_process.spawn — every test installs its own implementation
const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  CodexBackend,
  buildCodexArgs,
  buildCodexPrompt,
} from "../../../src/llm/codex-backend.js";

/** Build a fake ChildProcess that lets tests drive stdout/stderr/close events. */
function makeFakeProc() {
  const stdoutPush: string[] = [];
  let stdoutController: { push: (s: string | null) => void } | null = null;
  const stdout = new Readable({
    read() {
      // Drain queue
      while (stdoutPush.length > 0) {
        const next = stdoutPush.shift();
        if (next === undefined) break;
        this.push(next);
      }
      stdoutController = this as unknown as {
        push: (s: string | null) => void;
      };
    },
  });
  const stderr = new Readable({
    read() {
      // Initially nothing
    },
  });

  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (signal?: string) => void;
    killed: boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  proc.killed = false;
  proc.kill = vi.fn((_signal?: string) => {
    proc.killed = true;
  }) as unknown as typeof proc.kill;

  return {
    proc,
    /** Write a single JSONL line (newline appended automatically). */
    emitLine: (json: object | string) => {
      const text = typeof json === "string" ? json : JSON.stringify(json);
      const line = text + "\n";
      // Use the most recently captured controller (post-flow), otherwise queue.
      if (stdoutController) {
        stdoutController.push(line);
      } else {
        stdoutPush.push(line);
      }
    },
    emitClose: (code: number) => {
      // Allow stdout to flush
      setImmediate(() => {
        if (stdoutController) stdoutController.push(null);
        proc.emit("close", code);
      });
    },
    emitError: (err: Error) => {
      setImmediate(() => proc.emit("error", err));
    },
  };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- argv / prompt construction (pure) ----------

describe("buildCodexPrompt", () => {
  it("wraps the user prompt with klausbot identity and reminder", () => {
    const out = buildCodexPrompt("hello world");
    expect(out).toContain("<klausbot-system>");
    expect(out).toContain("You are klausbot");
    expect(out).toContain("<user_message>");
    expect(out).toContain("hello world");
    expect(out).toContain("<reminder>");
    expect(out).toContain("NEVER return empty");
  });

  it("includes additionalInstructions when provided", () => {
    const out = buildCodexPrompt("ping", "extra rule: be terse");
    expect(out).toContain("extra rule: be terse");
  });
});

describe("buildCodexArgs", () => {
  const baseCfg = {
    binary: "codex",
    sandbox: "read-only" as const,
    cwd: "/home/openclaw/.klausbot",
    skipGitRepoCheck: true,
  };

  it("builds the default exec invocation with --json --skip-git-repo-check --sandbox -C", () => {
    const args = buildCodexArgs(baseCfg, {}, "WRAPPED");
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      "/home/openclaw/.klausbot",
      "WRAPPED",
    ]);
  });

  it("includes resume sub-command and session id when resumeSessionId is set", () => {
    const args = buildCodexArgs(
      baseCfg,
      { resumeSessionId: "abc-123" },
      "WRAPPED",
    );
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "abc-123"]);
    expect(args).toContain("--json");
  });

  it("omits --sandbox and -C on the resume path (codex exec resume rejects them)", () => {
    // Regression: previously buildCodexArgs added --sandbox and -C
    // unconditionally, which made `codex exec resume` exit with code 2:
    //   "error: unexpected argument '--sandbox' found"
    // Both flags are only valid on fresh `codex exec`; the resumed session
    // inherits the original sandbox + cwd from the thread record.
    const args = buildCodexArgs(
      baseCfg,
      { resumeSessionId: "abc-123" },
      "WRAPPED",
    );
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-C");
    expect(args).toContain("--skip-git-repo-check"); // still valid on resume
  });

  it("includes --sandbox and -C on the fresh exec path", () => {
    // Sanity check — the fresh path must keep both flags.
    const args = buildCodexArgs(baseCfg, {}, "WRAPPED");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe("/home/openclaw/.klausbot");
  });

  it("uses cfg.model when set", () => {
    const args = buildCodexArgs({ ...baseCfg, model: "gpt-5-codex" }, {}, "P");
    const idx = args.indexOf("-m");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gpt-5-codex");
  });

  it("ignores options.model since the top-level klausbot 'model' field is Claude-Code-specific", () => {
    // options.model could be e.g. "claude-opus-4-6" — must NOT be passed to codex
    // (codex would reject "The 'claude-opus-4-6' model is not supported").
    const args = buildCodexArgs(baseCfg, { model: "claude-opus-4-6" }, "P");
    expect(args).not.toContain("-m");
  });

  it("cfg.model wins over options.model when both are set", () => {
    const args = buildCodexArgs(
      { ...baseCfg, model: "o3" },
      { model: "claude-opus-4-6" },
      "P",
    );
    expect(args[args.indexOf("-m") + 1]).toBe("o3");
  });

  it('emits -c model_reasoning_effort="..." when reasoningEffort is set', () => {
    const args = buildCodexArgs(
      { ...baseCfg, reasoningEffort: "high" },
      {},
      "P",
    );
    const idx = args.indexOf("-c");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('model_reasoning_effort="high"');
  });

  it("omits --skip-git-repo-check when skipGitRepoCheck=false", () => {
    const args = buildCodexArgs(
      { ...baseCfg, skipGitRepoCheck: false },
      {},
      "P",
    );
    expect(args).not.toContain("--skip-git-repo-check");
  });

  it("threads workspace-write sandbox when configured", () => {
    const args = buildCodexArgs(
      { ...baseCfg, sandbox: "workspace-write" },
      {},
      "P",
    );
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });
});

// ---------- query() / stream() event handling ----------

describe("CodexBackend.query (via mocked spawn)", () => {
  it("captures session_id from thread.started and accumulates agent_message text", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("hi");

    // Drive the JSONL events
    setImmediate(() => {
      fake.emitLine({
        type: "thread.started",
        thread_id: "session-uuid-1",
      });
      fake.emitLine({ type: "turn.started" });
      fake.emitLine({
        type: "item.completed",
        item: { id: "i0", type: "agent_message", text: "Hello!" },
      });
      fake.emitLine({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.result).toBe("Hello!");
    expect(r.session_id).toBe("session-uuid-1");
    expect(r.cost_usd).toBe(0);
    expect(r.is_error).toBe(false);
    expect(r.toolUse).toBeUndefined();
  });

  it("concatenates multiple agent_message events with newlines", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("multi");

    setImmediate(() => {
      fake.emitLine({ type: "thread.started", thread_id: "s2" });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "First." },
      });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Second." },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.result).toBe("First.\nSecond.");
  });

  it("captures function_call items as toolUse entries with parsed arguments", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("call a tool");

    setImmediate(() => {
      fake.emitLine({ type: "thread.started", thread_id: "s3" });
      fake.emitLine({
        type: "item.completed",
        item: {
          type: "function_call",
          name: "search_memories",
          arguments: '{"query":"who is Aditya"}',
        },
      });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Aditya is a developer." },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.toolUse).toEqual([
      { name: "search_memories", input: { query: "who is Aditya" } },
    ]);
    expect(r.result).toBe("Aditya is a developer.");
  });

  it("falls back to {_raw} when function_call arguments aren't valid JSON", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("garbled args");

    setImmediate(() => {
      fake.emitLine({ type: "thread.started", thread_id: "s4" });
      fake.emitLine({
        type: "item.completed",
        item: { type: "function_call", name: "x", arguments: "{not-json" },
      });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.toolUse).toEqual([{ name: "x", input: { _raw: "{not-json" } }]);
  });

  it("ignores non-JSON status lines like 'Reading additional input from stdin...'", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("test");

    setImmediate(() => {
      fake.emitLine("Reading additional input from stdin...");
      fake.emitLine({ type: "thread.started", thread_id: "s5" });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "OK" },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.result).toBe("OK");
    expect(r.session_id).toBe("s5");
  });

  it("rejects with a descriptive error on non-zero exit code", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("fail");

    setImmediate(() => {
      // Emit some stderr for the rejection message
      fake.proc.stderr.push("ERROR: something broke\n");
      fake.proc.stderr.push(null);
      fake.emitClose(2);
    });

    await expect(promise).rejects.toThrow(/Codex exited with code 2/);
  });

  it("rejects when spawn itself errors", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.query("spawn-fail");

    setImmediate(() => {
      fake.emitError(new Error("ENOENT: codex not found"));
    });

    await expect(promise).rejects.toThrow(/Failed to start codex/);
  });
});

describe("CodexBackend.stream (via mocked spawn)", () => {
  it("invokes onChunk for each agent_message item", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const chunks: string[] = [];
    const promise = backend.stream("stream me", {}, (text) =>
      chunks.push(text),
    );

    setImmediate(() => {
      fake.emitLine({ type: "thread.started", thread_id: "s6" });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Part 1" },
      });
      fake.emitLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Part 2" },
      });
      fake.emitClose(0);
    });

    const r = await promise;
    expect(chunks).toEqual(["Part 1", "\nPart 2"]);
    expect(r.result).toBe("Part 1\nPart 2");
    expect(r.messageSent).toBe(false);
  });
});

// ---------- health() ----------

describe("CodexBackend.health()", () => {
  it("returns ok=true when `codex login status` exits 0 with 'Logged in'", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.health();

    setImmediate(() => {
      fake.proc.stdout.push("Logged in using ChatGPT\n");
      fake.proc.stdout.push(null);
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.ok).toBe(true);
  });

  it("returns ok=true when 'Logged in' appears on STDERR (codex's actual behavior)", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.health();

    setImmediate(() => {
      fake.proc.stderr.push("Logged in using ChatGPT\n");
      fake.proc.stderr.push(null);
      fake.proc.stdout.push(null);
      fake.emitClose(0);
    });

    const r = await promise;
    expect(r.ok).toBe(true);
  });

  it("returns ok=false on non-zero exit", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.health();

    setImmediate(() => {
      fake.proc.stderr.push("Not logged in\n");
      fake.proc.stderr.push(null);
      fake.emitClose(1);
    });

    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/exit 1/);
  });

  it("returns ok=false when codex binary cannot be spawned", async () => {
    const fake = makeFakeProc();
    spawnMock.mockReturnValueOnce(fake.proc);

    const backend = new CodexBackend();
    const promise = backend.health();

    setImmediate(() => {
      fake.emitError(new Error("ENOENT"));
    });

    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Failed to invoke codex/);
  });
});

// ---------- backend id ----------

describe("CodexBackend identity", () => {
  it("exposes id = 'codex'", () => {
    expect(new CodexBackend().id).toBe("codex");
  });
});
