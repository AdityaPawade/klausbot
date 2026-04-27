/**
 * Quick benchmark: test each candidate Ollama model on klausbot-shaped tool-call
 * scenarios. Scores each model on:
 *   - Does it emit a syntactically-valid tool_call when expected?
 *   - Does it pick the right tool?
 *   - Does it pass plausible arguments?
 *   - How fast is the response?
 *
 * Run on Pi: node scripts/benchmark-models.mjs
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const MODELS = [
  "qwen3:4b",
  "qwen3:8b",
  "phi4-mini:3.8b",
  // "gemma3:12b", // skip — slow on Pi for this test
];

// Approximate the klausbot MCP tool schemas
const TOOLS = [
  {
    type: "function",
    function: {
      name: "create_cron",
      description:
        "Schedule a recurring task. The schedule uses standard cron syntax (5 fields).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short identifier for the cron" },
          schedule: { type: "string", description: "Cron schedule expression" },
          instruction: {
            type: "string",
            description: "What klausbot should do when the cron fires",
          },
          chat_id: { type: "number", description: "Telegram chat id" },
        },
        required: ["name", "schedule", "instruction", "chat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Semantic search over past conversations and stored memories. Use this when the user asks about anything they previously told the bot.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_crons",
      description: "List all scheduled crons for a chat",
      parameters: {
        type: "object",
        properties: {
          chat_id: { type: "number", description: "Telegram chat id" },
        },
        required: ["chat_id"],
      },
    },
  },
];

const SCENARIOS = [
  {
    label: "create_cron — clear request",
    prompt:
      "Set up a cron job that pings me every weekday at 9am with the heading 'morning check' and instruction 'Summarize overnight Slack and email'. My chat id is 12345.",
    expectedTool: "create_cron",
    expectedArgKeys: ["name", "schedule", "instruction", "chat_id"],
  },
  {
    label: "search_memories — recall request",
    prompt:
      "What did I tell you yesterday about my new job at the FPGA company?",
    expectedTool: "search_memories",
    expectedArgKeys: ["query"],
  },
  {
    label: "list_crons — direct request",
    prompt: "Show me all my scheduled tasks. chat id 12345.",
    expectedTool: "list_crons",
    expectedArgKeys: ["chat_id"],
  },
  {
    label: "no tool needed — chat",
    prompt: "Hey klaus, how's it going?",
    expectedTool: null, // should NOT call a tool
  },
];

const SYSTEM = `You are klausbot, a Telegram personal assistant. When the user
asks for actions you can do via tools, call the appropriate tool with valid
arguments. When the user just chats, reply normally without calling tools.`;

async function runOne(model, scenario) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: scenario.prompt },
        ],
        tools: TOOLS,
        options: { temperature: 0.2 },
      }),
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${await res.text()}`, ms };
  }
  const data = await res.json();
  const calls = data?.message?.tool_calls;
  const content = data?.message?.content ?? "";

  // Score it
  if (scenario.expectedTool === null) {
    // Should NOT have called a tool
    if (!calls || calls.length === 0) return { ok: true, ms, content: content.slice(0, 80) };
    return {
      ok: false,
      error: `Unexpected tool call: ${calls.map((c) => c.function.name).join(",")}`,
      ms,
    };
  }

  if (!calls || calls.length === 0) {
    return { ok: false, error: `Expected ${scenario.expectedTool}, got plain text: ${content.slice(0, 80)}`, ms };
  }
  const call = calls[0];
  if (call.function.name !== scenario.expectedTool) {
    return { ok: false, error: `Wrong tool: ${call.function.name}`, ms };
  }
  // Validate args
  const args =
    typeof call.function.arguments === "string"
      ? safeParse(call.function.arguments)
      : call.function.arguments;
  if (!args) {
    return { ok: false, error: `Args not parseable JSON: ${call.function.arguments}`, ms };
  }
  const missing = scenario.expectedArgKeys.filter((k) => !(k in args));
  if (missing.length > 0) {
    return { ok: false, error: `Missing required args: ${missing.join(",")} got: ${JSON.stringify(args)}`, ms };
  }
  return { ok: true, ms, args };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main() {
  const results = {};
  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    results[model] = { passed: 0, failed: 0, totalMs: 0, runs: [] };
    for (const scenario of SCENARIOS) {
      process.stdout.write(`  ${scenario.label.padEnd(36)} `);
      const r = await runOne(model, scenario);
      results[model].runs.push({ scenario: scenario.label, ...r });
      results[model].totalMs += r.ms;
      if (r.ok) {
        results[model].passed += 1;
        console.log(`PASS ${r.ms}ms`);
      } else {
        results[model].failed += 1;
        console.log(`FAIL ${r.ms}ms — ${r.error}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`${"Model".padEnd(20)} ${"Pass".padEnd(8)} ${"Fail".padEnd(8)} ${"Avg ms".padEnd(10)}`);
  for (const [model, r] of Object.entries(results)) {
    const avg = Math.round(r.totalMs / SCENARIOS.length);
    console.log(`${model.padEnd(20)} ${String(r.passed).padEnd(8)} ${String(r.failed).padEnd(8)} ${String(avg).padEnd(10)}`);
  }

  // Pick winner: most passes, then fastest
  const ranked = Object.entries(results)
    .map(([m, r]) => ({ model: m, score: r.passed, avgMs: r.totalMs / SCENARIOS.length }))
    .sort((a, b) => b.score - a.score || a.avgMs - b.avgMs);
  console.log(`\nWINNER: ${ranked[0].model} (${ranked[0].score}/${SCENARIOS.length} passes, ${Math.round(ranked[0].avgMs)}ms avg)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
