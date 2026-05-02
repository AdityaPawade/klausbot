/**
 * Code Mode wrapper — Cloudflare's "give the model code, not tool calls" pattern.
 *
 * Background:
 *   Local LLMs (especially small ones) struggle with structured tool calling
 *   but excel at writing code. Cloudflare measured 32-94% token reduction and
 *   dramatically better correctness when tools are exposed as a typed JS API
 *   and the model writes one piece of code that calls multiple tools — vs.
 *   emitting N separate tool-call JSON blobs.
 *
 * Architecture:
 *   1. Convert the MCP tool list to a JS API surface description (typed).
 *   2. Expose ONE tool to the model: `executeJs(code)`.
 *   3. Run the model's code in a vm.Context sandbox where `tools.<name>(args)`
 *      proxies to the MCP bridge.
 *   4. Return stdout (console.log) + the final value to the model.
 *
 * Tradeoffs vs. native tool calling:
 *   + Far more reliable on small models (writes natural code instead of
 *     contrived JSON tool blobs)
 *   + One round trip can call multiple tools sequentially
 *   + Tokens spent describing tools collapse from ~5000 chars to ~600
 *   - Sandbox needs care (we use vm with no Node intrinsics — pure JS only)
 *   - Async tool calls become explicit await in user code
 */

import vm from "vm";
import type { McpBridge, OllamaTool } from "./mcp-bridge.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("code-mode");

/** The single tool we expose to the model when Code Mode is on */
export const CODE_MODE_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: "executeJs",
    description:
      "Execute a JavaScript code snippet that uses the provided typed API to perform actions. Use this whenever you need to call any tool. The code runs in a sandbox; only the `tools` object and standard JS (no Node modules, no fs, no network). Use top-level await for tool calls. Return useful values via the last expression or console.log.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript source. Has access to `tools.<name>(args)` for every available tool. Example: `const r = await tools.search_memories({query: 'fpga work'}); return r;`",
        },
      },
      required: ["code"],
    },
  },
};

/**
 * Build a system prompt fragment that documents the typed API the model
 * can call from inside `executeJs`. This replaces the per-tool schema dump
 * — usually 5x shorter than describing each tool as a separate tool.
 */
export function buildCodeModeApiDoc(mcpTools: OllamaTool[]): string {
  if (mcpTools.length === 0) return "";

  const lines: string[] = [
    "## Available API inside executeJs",
    "",
    "When the user asks you to do something a tool can do, call `executeJs` with code that uses these typed methods:",
    "",
    "```ts",
    "// All methods are async and return string results.",
    "declare const tools: {",
  ];

  for (const t of mcpTools) {
    const name = t.function.name;
    const desc = t.function.description || "";
    const params = t.function.parameters as
      | {
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        }
      | undefined;
    const props = params?.properties ?? {};
    const required = new Set(params?.required ?? []);
    const argParts: string[] = [];
    for (const [key, schema] of Object.entries(props)) {
      const opt = required.has(key) ? "" : "?";
      const tsType = jsonSchemaTypeToTs(schema?.type);
      argParts.push(`${key}${opt}: ${tsType}`);
    }
    const argsSig = argParts.length > 0 ? `{ ${argParts.join("; ")} }` : "";
    lines.push(`  /** ${desc} */`);
    lines.push(
      `  ${name}(args${argsSig ? ": " + argsSig : "?: never"}): Promise<string>;`,
    );
  }

  lines.push("};");
  lines.push("```");
  lines.push("");
  lines.push("Example:");
  lines.push("```js");
  lines.push('// User: "set a 9am cron to drink water"');
  lines.push("await tools.create_cron({");
  lines.push("  name: 'water-reminder',");
  lines.push("  schedule: '0 9 * * *',");
  lines.push("  instruction: 'Remind me to drink water',");
  lines.push("  chat_id: <chat_id from session-context>");
  lines.push("});");
  lines.push("```");
  lines.push("");
  lines.push("Rules:");
  lines.push(
    "- Use `executeJs` whenever a tool would help; don't invent JSON tool-calls.",
  );
  lines.push("- Use top-level await; the runtime supports it.");
  lines.push(
    "- Last expression value is returned to you; you can also console.log().",
  );
  lines.push(
    "- Failures throw — no need for try/catch unless you want to recover.",
  );

  return lines.join("\n");
}

function jsonSchemaTypeToTs(t: string | undefined): string {
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "unknown[]";
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

/** Result of an executeJs call */
export interface ExecuteJsResult {
  /** Console.log output during execution */
  stdout: string;
  /** Errors / console.error / thrown error message */
  stderr: string;
  /** Last expression value (or undefined) */
  returnValue: unknown;
  /** Whether the code threw */
  threw: boolean;
}

/**
 * Execute a JS snippet in a sandbox where `tools.<name>(args)` proxies to
 * MCP tool calls. Returns the stdout + final value as a string the model
 * can read.
 */
export async function executeJsSandboxed(
  code: string,
  bridge: McpBridge,
  availableTools: OllamaTool[],
): Promise<ExecuteJsResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Build the `tools` object — each tool name maps to a function that
  // calls the bridge.
  const tools: Record<
    string,
    (args: Record<string, unknown>) => Promise<string>
  > = {};
  for (const t of availableTools) {
    const name = t.function.name;
    tools[name] = async (args = {}) => bridge.callTool(name, args);
  }

  // Wrap user code in an async IIFE so top-level await works
  const wrapped = `(async () => {\n${code}\n})()`;

  const ctx: Record<string, unknown> = {
    tools,
    console: {
      log: (...a: unknown[]) =>
        stdout.push(a.map((x) => stringify(x)).join(" ")),
      error: (...a: unknown[]) =>
        stderr.push(a.map((x) => stringify(x)).join(" ")),
      warn: (...a: unknown[]) =>
        stderr.push("[warn] " + a.map((x) => stringify(x)).join(" ")),
    },
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  };
  vm.createContext(ctx);

  let returnValue: unknown = undefined;
  let threw = false;
  try {
    const script = new vm.Script(wrapped, {
      filename: "user_code.js",
    });
    const promise = script.runInContext(ctx, { timeout: 30_000 });
    returnValue = await promise;
  } catch (err) {
    threw = true;
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    stderr.push(msg);
    log.warn({ err, codePreview: code.slice(0, 200) }, "executeJs threw");
  }

  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    returnValue,
    threw,
  };
}

function stringify(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/** Format ExecuteJsResult into a single string the model can read as tool output */
export function formatExecuteJsResult(r: ExecuteJsResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  if (r.returnValue !== undefined) {
    parts.push(`return:\n${stringify(r.returnValue)}`);
  }
  if (r.threw) parts.push("(execution threw an error)");
  return parts.join("\n\n") || "(no output)";
}
