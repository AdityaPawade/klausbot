#!/usr/bin/env node
/**
 * Targeted benchmark: llama-server with prefix caching.
 * Tests cold vs warm response times with the same system prompt + tools.
 */

const URL = process.env.LLAMA_URL || "http://localhost:8080";

const SYSTEM = "You are klausbot, a Telegram personal assistant. Reply concisely. When the user asks for an action a tool can do, call the appropriate tool with valid arguments. When the user just chats, reply naturally without calling tools.";

const TOOLS = [
  { type: "function", function: { name: "create_cron", description: "Schedule a recurring task with cron syntax (5 fields). Convert natural language times to cron format.", parameters: { type: "object", properties: { name: {type:"string"}, schedule: {type:"string", description:"5-field cron expression"}, instruction: {type:"string"}, chat_id: {type:"number"} }, required: ["name","schedule","instruction","chat_id"] } } },
  { type: "function", function: { name: "list_crons", description: "List all crons for a chat", parameters: { type: "object", properties: { chat_id: {type:"number"} }, required: ["chat_id"] } } },
  { type: "function", function: { name: "search_memories", description: "Search past conversations and memory for what the user previously said.", parameters: { type: "object", properties: { query: {type:"string"}, limit: {type:"number"} }, required: ["query"] } } },
];

const TASKS = [
  { id: "chat-hi", prompt: "Say hi in three words.", expectTool: null },
  { id: "schedule", prompt: "Set a cron at 9am weekdays to drink water. chat_id 1097409126.", expectTool: "create_cron" },
  { id: "list", prompt: "List my crons. chat_id 1097409126.", expectTool: "list_crons" },
  { id: "memory", prompt: "What do I know about FPGA?", expectTool: "search_memories" },
  { id: "leap", prompt: "If today is 27 April 2026, what is the next leap year? Reply with just the year number.", expectTool: null },
  { id: "chat-2", prompt: "Tell me one fun fact in one sentence.", expectTool: null },
];

async function call(prompt) {
  const t0 = Date.now();
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "any",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      tools: TOOLS,
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
  const d = await res.json();
  const msg = d.choices?.[0]?.message;
  return {
    ok: true,
    ms,
    text: msg?.content ?? "",
    tools: msg?.tool_calls?.map((t) => ({ name: t.function.name, args: safeParse(t.function.arguments) })) ?? [],
    cached: d.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    promptTokens: d.usage?.prompt_tokens,
    completionTokens: d.usage?.completion_tokens,
    timings: d.timings,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function scoreTask(task, r) {
  if (!r.ok) return 0;
  if (task.expectTool === null) {
    return r.tools.length === 0 && r.text.length > 0 ? 1 : 0;
  }
  return r.tools.find((t) => t.name === task.expectTool) ? 1 : 0;
}

async function main() {
  console.log("=== llama-server + qwen3:1.7b + prefix caching ===");
  console.log(`URL: ${URL}\n`);

  const results = [];
  for (let pass = 1; pass <= 2; pass++) {
    console.log(`--- Pass ${pass} ${pass === 1 ? "(cold)" : "(warm — same prefix should hit cache)"} ---`);
    for (const t of TASKS) {
      process.stdout.write(`  ${t.id.padEnd(12)} `);
      const r = await call(t.prompt);
      const s = scoreTask(t, r);
      const cached = r.cached ?? 0;
      const total = r.promptTokens ?? 0;
      const cacheHit = total > 0 ? Math.round((cached / total) * 100) : 0;
      console.log(
        `score=${s} t=${r.ms}ms cache=${cached}/${total}(${cacheHit}%) tools=${r.tools.length} text="${(r.text||"").slice(0,50).replace(/\n/g," ")}"`,
      );
      results.push({ pass, task: t.id, ...r, score: s });
    }
  }

  // Summary
  const pass1 = results.filter((r) => r.pass === 1);
  const pass2 = results.filter((r) => r.pass === 2);
  const sum = (rs) => rs.reduce((a, b) => a + b.ms, 0);
  const sumScore = (rs) => rs.reduce((a, b) => a + b.score, 0);
  console.log(`\n=== Summary ===`);
  console.log(`Pass 1 (cold): ${sum(pass1)}ms total, score ${sumScore(pass1)}/${TASKS.length}, avg ${Math.round(sum(pass1)/TASKS.length)}ms/task`);
  console.log(`Pass 2 (warm): ${sum(pass2)}ms total, score ${sumScore(pass2)}/${TASKS.length}, avg ${Math.round(sum(pass2)/TASKS.length)}ms/task`);
  console.log(`Speedup: ${(sum(pass1) / sum(pass2)).toFixed(2)}x`);

  // Cache hit analysis
  const totalCacheBytes = results.reduce((a, b) => a + (b.cached ?? 0), 0);
  const totalPromptBytes = results.reduce((a, b) => a + (b.promptTokens ?? 0), 0);
  console.log(`Cache utilization: ${Math.round((totalCacheBytes / totalPromptBytes) * 100)}% of prompt tokens cached`);
}

main().catch(e => { console.error(e); process.exit(1); });
