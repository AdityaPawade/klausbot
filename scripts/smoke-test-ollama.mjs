#!/usr/bin/env node
/**
 * Direct OllamaBackend smoke test — runs against the actual Pi setup.
 *
 *   1. Health check (Ollama up + model present)
 *   2. Simple non-tool prompt
 *   3. Tool-routing prompt (should call search_memories)
 *   4. Streaming
 *
 * Run on Pi: cd ~/Projects/Agents/klausbot && node scripts/smoke-test-ollama.mjs
 */

import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MODEL = process.env.SMOKE_MODEL || "qwen3:4b";
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";

console.log(`=== Smoke test: Ollama backend with ${MODEL} ===`);

// Step 1: Health
console.log("\n[1] Ollama health");
const tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
const found = tags.models?.find((m) => m.name === MODEL);
if (!found) {
  console.log(`  FAIL: model ${MODEL} not pulled`);
  process.exit(1);
}
console.log(`  OK: ${MODEL} (${(found.size / 1e9).toFixed(2)} GB)`);

// Step 2: Connect MCP bridge
console.log("\n[2] MCP bridge connect");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "mcp"],
});
const client = new Client(
  { name: "smoke-test", version: "1.0.0" },
  { capabilities: {} },
);
await client.connect(transport);
const toolsResult = await client.listTools();
console.log(`  OK: ${toolsResult.tools.length} tools available`);
toolsResult.tools.forEach((t) => console.log(`     - ${t.name}`));

const ollamaTools = toolsResult.tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema ?? { type: "object", properties: {} },
  },
}));

// Step 3: Simple prompt
console.log(`\n[3] Simple prompt (no tools needed)`);
const t1 = Date.now();
const r1 = await fetch(`${OLLAMA}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [
      { role: "system", content: "You are klausbot. Reply briefly." },
      { role: "user", content: "Reply with exactly the words: hello from ollama" },
    ],
    options: { temperature: 0.1 },
  }),
});
const d1 = await r1.json();
console.log(`  ${Date.now() - t1}ms: ${d1.message?.content?.slice(0, 100)}`);

// Step 4: Tool-routing prompt
console.log(`\n[4] Tool-routing prompt (search_memories expected)`);
const t2 = Date.now();
const r2 = await fetch(`${OLLAMA}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are klausbot. When the user asks about past conversations or memories, call the search_memories tool.",
      },
      { role: "user", content: "What do you remember about FPGA work?" },
    ],
    tools: ollamaTools,
    options: { temperature: 0.1 },
  }),
});
const d2 = await r2.json();
const calls = d2.message?.tool_calls;
if (calls && calls.length > 0) {
  console.log(`  ${Date.now() - t2}ms: ${calls.length} tool call(s)`);
  for (const c of calls) {
    console.log(`     - ${c.function.name}(${JSON.stringify(c.function.arguments).slice(0, 100)})`);
    // Actually call the MCP tool to verify the bridge works
    try {
      const args =
        typeof c.function.arguments === "string"
          ? JSON.parse(c.function.arguments)
          : c.function.arguments;
      const tr = await client.callTool({ name: c.function.name, arguments: args });
      const text =
        tr.content
          ?.filter((b) => b.type === "text")
          ?.map((b) => b.text)
          .join("\n")
          .slice(0, 200) ?? "(no content)";
      console.log(`       result: ${text}`);
    } catch (err) {
      console.log(`       MCP call FAIL: ${err.message}`);
    }
  }
} else {
  console.log(`  ${Date.now() - t2}ms: NO tool calls. Plain text: ${d2.message?.content?.slice(0, 200)}`);
}

await client.close();
console.log(`\n=== Smoke test complete ===`);
