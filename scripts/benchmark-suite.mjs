#!/usr/bin/env node
/**
 * Comprehensive benchmark across (engine x model x mode) for klausbot's
 * actual use-cases: chat, tool routing, multi-step reasoning, code-gen.
 *
 * Run on Pi: cd ~/Projects/Agents/klausbot && node scripts/benchmark-suite.mjs
 *
 * Required env:
 *   - OLLAMA_URL (default http://localhost:11434)
 *   - LLAMA_CPP_URL (default http://localhost:8080)
 *   - SUITE (comma-list of configs to run; e.g. "ollama-qwen3-4b,ollama-qwen3-1.7b")
 *
 * Outputs CSV-style summary + per-task details.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
const LLAMACPP = process.env.LLAMA_CPP_URL || "http://localhost:8080";

// ---------- MCP bridge ----------
let mcpClient = null;
let mcpTools = [];

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "mcp"],
  });
  mcpClient = new Client(
    { name: "benchmark", version: "1.0.0" },
    { capabilities: {} },
  );
  await mcpClient.connect(transport);
  const r = await mcpClient.listTools();
  mcpTools = r.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  console.log(`MCP: connected, ${mcpTools.length} tools`);
}

// ---------- Code Mode ----------
function buildCodeModeApiDoc(tools) {
  const lines = [
    "## Available API inside executeJs",
    "When the user asks for an action a tool can do, call executeJs with code that uses these typed methods:",
    "```ts",
    "declare const tools: {",
  ];
  for (const t of tools) {
    const props = t.function.parameters?.properties ?? {};
    const required = new Set(t.function.parameters?.required ?? []);
    const args = Object.entries(props)
      .map(([k, s]) => `${k}${required.has(k) ? "" : "?"}: ${jsToType(s.type)}`)
      .join("; ");
    lines.push(`  /** ${t.function.description ?? ""} */`);
    lines.push(
      `  ${t.function.name}(args${args ? `: { ${args} }` : "?: never"}): Promise<string>;`,
    );
  }
  lines.push("};");
  lines.push("```");
  lines.push(
    "Rules: only call executeJs (no other tools). Use top-level await.",
  );
  return lines.join("\n");
}
function jsToType(t) {
  return (
    {
      string: "string",
      number: "number",
      integer: "number",
      boolean: "boolean",
      array: "unknown[]",
      object: "Record<string,unknown>",
    }[t] || "unknown"
  );
}

const CODE_MODE_TOOL = {
  type: "function",
  function: {
    name: "executeJs",
    description:
      "Execute JS that uses tools.<name>(args). Use this for ALL actions.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "JS source." } },
      required: ["code"],
    },
  },
};

// ---------- Tasks ----------
const TASKS = [
  {
    id: "chat-hi",
    prompt: "Say hi in five words.",
    expect: { tool: null }, // no tool call
    score: (out, calls) =>
      calls.length === 0 && out.length > 0 && out.length < 80 ? 1 : 0,
  },
  {
    id: "time-what",
    prompt:
      "What's a quick way to remember the current date in one short sentence?",
    expect: { tool: null },
    score: (out, calls) => (calls.length === 0 && out.length > 10 ? 1 : 0),
  },
  {
    id: "schedule-cron",
    prompt:
      "Set up a cron that pings me at 9am every weekday with the instruction 'check overnight emails'. Use chat_id 1097409126.",
    expect: { tool: "create_cron" },
    score: (out, calls) => {
      const c = calls.find((c) => c.name === "create_cron");
      if (!c) return 0;
      const args = c.args || {};
      // schedule must look like cron, instruction must mention emails
      return (
        (typeof args.schedule === "string" && /\d/.test(args.schedule)
          ? 1
          : 0) *
        (typeof args.instruction === "string" &&
        args.instruction.toLowerCase().includes("email")
          ? 1
          : 0.5)
      );
    },
  },
  {
    id: "list-crons",
    prompt: "Show me all my scheduled tasks. chat_id 1097409126.",
    expect: { tool: "list_crons" },
    score: (out, calls) => (calls.find((c) => c.name === "list_crons") ? 1 : 0),
  },
  {
    id: "memory-recall",
    prompt: "What do you remember about my FPGA work?",
    expect: { tool: "search_memories" },
    score: (out, calls) =>
      calls.find((c) => c.name === "search_memories") ? 1 : 0,
  },
  {
    id: "reasoning-leap-year",
    prompt:
      "If today is 27 April 2026, what's the next leap year? Reply with just the year.",
    expect: { tool: null },
    score: (out) => (/2028/.test(out) ? 1 : 0),
  },
];

// ---------- Engine adapters ----------
async function callOllama({
  baseUrl,
  model,
  system,
  messages,
  tools,
  codeMode,
}) {
  const sysFinal = codeMode
    ? system + "\n\n" + buildCodeModeApiDoc(mcpTools)
    : system;
  const allMessages = [{ role: "system", content: sysFinal }, ...messages];

  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: allMessages,
      tools,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { num_ctx: 16000, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(600_000), // 10 min hard cap
  });
  const totalMs = Date.now() - t0;
  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      totalMs,
    };
  }
  const data = await res.json();
  return {
    ok: true,
    totalMs,
    raw: data,
    text: data.message?.content || "",
    tool_calls: data.message?.tool_calls || [],
    eval_count: data.eval_count,
    prompt_eval_count: data.prompt_eval_count,
  };
}

// ---------- Run one task against one config ----------
async function runTask(task, cfg) {
  // Build the tool list and possibly run inner JS
  const tools = cfg.codeMode ? [CODE_MODE_TOOL] : mcpTools;

  // First call
  const r1 = await callOllama({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    system: cfg.system,
    messages: [{ role: "user", content: task.prompt }],
    tools,
    codeMode: cfg.codeMode,
  });

  if (!r1.ok) {
    return { ok: false, error: r1.error, totalMs: r1.totalMs };
  }

  // Collect tool calls (resolved into MCP-name+args pairs even in Code Mode)
  const calls = [];
  if (cfg.codeMode && r1.tool_calls && r1.tool_calls.length > 0) {
    for (const tc of r1.tool_calls) {
      if (tc.function.name === "executeJs") {
        const code =
          typeof tc.function.arguments === "string"
            ? (safeParse(tc.function.arguments)?.code ?? "")
            : (tc.function.arguments?.code ?? "");
        const innerCalls = parseInnerToolCalls(code);
        calls.push(...innerCalls);
      } else {
        const args =
          typeof tc.function.arguments === "string"
            ? safeParse(tc.function.arguments)
            : tc.function.arguments;
        calls.push({ name: tc.function.name, args });
      }
    }
  } else {
    for (const tc of r1.tool_calls || []) {
      const args =
        typeof tc.function.arguments === "string"
          ? safeParse(tc.function.arguments)
          : tc.function.arguments;
      calls.push({ name: tc.function.name, args });
    }
  }

  const cleanText = stripThink(r1.text);
  const score = task.score(cleanText, calls);

  return {
    ok: true,
    totalMs: r1.totalMs,
    text: cleanText,
    rawText: r1.text,
    calls,
    score,
    eval_count: r1.eval_count,
    prompt_eval_count: r1.prompt_eval_count,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function stripThink(s) {
  if (!s) return s;
  const i = s.lastIndexOf("</think>");
  return i >= 0 ? s.slice(i + 8).trim() : s;
}

/** Crude regex parse of `tools.<name>(<json>)` calls inside the code blob */
function parseInnerToolCalls(code) {
  if (!code) return [];
  const calls = [];
  const re = /tools\.(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    let args = null;
    try {
      // Loose JS-object literal — try wrapping with parens for eval
      // Avoid eval; convert single-quotes and try JSON parse
      const norm = m[2].replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":');
      args = safeParse(norm);
    } catch {
      args = { _raw: m[2] };
    }
    calls.push({ name, args: args ?? { _raw: m[2] } });
  }
  return calls;
}

// ---------- Configs to test ----------
const SYSTEM =
  "You are klausbot, a Telegram personal assistant for Aditya. Reply concisely. When the user asks for an action a tool can do, call the appropriate tool with valid arguments. When the user just chats, reply naturally without calling tools.";

const ALL_CONFIGS = {
  "ollama-qwen3-4b-native": {
    baseUrl: OLLAMA,
    model: "qwen3:4b",
    system: SYSTEM,
    codeMode: false,
  },
  "ollama-qwen3-4b-code": {
    baseUrl: OLLAMA,
    model: "qwen3:4b",
    system: SYSTEM,
    codeMode: true,
  },
  "ollama-qwen3-1.7b-native": {
    baseUrl: OLLAMA,
    model: "qwen3:1.7b",
    system: SYSTEM,
    codeMode: false,
  },
  "ollama-qwen3-1.7b-code": {
    baseUrl: OLLAMA,
    model: "qwen3:1.7b",
    system: SYSTEM,
    codeMode: true,
  },
  "ollama-llama3.2-3b-native": {
    baseUrl: OLLAMA,
    model: "llama3.2:3b",
    system: SYSTEM,
    codeMode: false,
  },
  "ollama-llama3.2-3b-code": {
    baseUrl: OLLAMA,
    model: "llama3.2:3b",
    system: SYSTEM,
    codeMode: true,
  },
  "ollama-phi4-mini-native": {
    baseUrl: OLLAMA,
    model: "phi4-mini:3.8b",
    system: SYSTEM,
    codeMode: false,
  },
  "ollama-qwen3-0.6b-native": {
    baseUrl: OLLAMA,
    model: "qwen3:0.6b",
    system: SYSTEM,
    codeMode: false,
  },
  "llamacpp-qwen3-4b-native": {
    baseUrl: LLAMACPP,
    model: "auto",
    system: SYSTEM,
    codeMode: false,
  },
  "llamacpp-qwen3-4b-code": {
    baseUrl: LLAMACPP,
    model: "auto",
    system: SYSTEM,
    codeMode: true,
  },
};

const SUITE = (
  process.env.SUITE ||
  "ollama-qwen3-4b-native,ollama-qwen3-4b-code,ollama-qwen3-1.7b-native,ollama-llama3.2-3b-native"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Main ----------
async function main() {
  await connectMcp();

  const results = {};
  for (const cfgName of SUITE) {
    const cfg = ALL_CONFIGS[cfgName];
    if (!cfg) {
      console.log(`SKIP unknown config: ${cfgName}`);
      continue;
    }
    console.log(`\n=== ${cfgName} ===`);
    results[cfgName] = { tasks: {}, totalScore: 0, totalMs: 0, fail: 0 };
    for (const task of TASKS) {
      process.stdout.write(`  ${task.id.padEnd(28)} `);
      try {
        const r = await runTask(task, cfg);
        results[cfgName].tasks[task.id] = r;
        if (r.ok) {
          results[cfgName].totalScore += r.score;
          results[cfgName].totalMs += r.totalMs;
          console.log(
            `score=${r.score.toFixed(2)} t=${r.totalMs}ms tools=${r.calls.length} text="${(r.text || "").slice(0, 60).replace(/\n/g, " ")}"`,
          );
        } else {
          results[cfgName].fail += 1;
          console.log(`FAIL t=${r.totalMs}ms err=${r.error}`);
        }
      } catch (err) {
        results[cfgName].fail += 1;
        console.log(`CRASH ${err.message}`);
      }
    }
  }

  // Summary
  console.log("\n\n=== SUMMARY ===");
  console.log(
    "Config".padEnd(32) +
      "Score".padStart(8) +
      "TotMs".padStart(10) +
      "Avg/task".padStart(12) +
      "Fails".padStart(7),
  );
  const ranked = Object.entries(results).map(([name, r]) => ({
    name,
    score: r.totalScore,
    totalMs: r.totalMs,
    avg: Math.round(r.totalMs / TASKS.length),
    fail: r.fail,
  }));
  ranked.sort((a, b) => b.score - a.score || a.avg - b.avg);
  for (const r of ranked) {
    console.log(
      r.name.padEnd(32) +
        r.score.toFixed(2).padStart(8) +
        String(r.totalMs).padStart(10) +
        String(r.avg).padStart(12) +
        String(r.fail).padStart(7),
    );
  }

  // Write JSON for analysis
  const fs = await import("fs");
  fs.writeFileSync(
    "/tmp/benchmark-results.json",
    JSON.stringify(results, null, 2),
  );
  console.log("\nFull results: /tmp/benchmark-results.json");

  await mcpClient.close();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
