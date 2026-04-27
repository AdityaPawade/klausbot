/**
 * MCP bridge — connects to klausbot's own MCP server over stdio and exposes
 * its tools in OpenAI/Ollama function-calling shape.
 *
 * Reuses the EXACT same MCP server that the Claude Code path uses, so tool
 * implementations don't change. We just give Ollama-class models a way to
 * see and call them.
 */

import { spawn, type ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp-bridge");

/** Tool description in OpenAI/Ollama function-calling shape */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema (already what MCP gives us)
  };
}

export class McpBridge {
  private client: Client | null = null;
  private childProcess: ChildProcess | null = null;
  private cachedTools: OllamaTool[] | null = null;

  /** Connect to klausbot's MCP server (spawned as a child process) */
  async connect(): Promise<void> {
    if (this.client) return;

    // Same invocation pattern as spawner.ts getMcpConfig — spawn the current
    // executable with the `mcp` subcommand. Works in dev (node dist/index.js)
    // and in installed binary (klausbot mcp).
    const transport = new StdioClientTransport({
      command: process.argv[0], // node executable
      args: [process.argv[1], "mcp"], // [script path, mcp subcommand]
      env: process.env as Record<string, string>,
    });

    this.client = new Client(
      { name: "klausbot-ollama-bridge", version: "1.0.0" },
      { capabilities: {} },
    );

    log.info("Connecting MCP client to klausbot MCP server");
    await this.client.connect(transport);
    log.info("MCP client connected");
  }

  /** List tools from the MCP server, converted to Ollama function-calling shape */
  async listTools(): Promise<OllamaTool[]> {
    if (this.cachedTools) return this.cachedTools;
    if (!this.client) throw new Error("MCP bridge not connected");

    const result = await this.client.listTools();
    const tools: OllamaTool[] = result.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters:
          (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
      },
    }));

    log.info({ count: tools.length, names: tools.map((x) => x.function.name) }, "Discovered MCP tools");
    this.cachedTools = tools;
    return tools;
  }

  /** Execute a tool call by name and return the textual result */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP bridge not connected");

    log.debug({ name, args }, "Calling MCP tool");
    try {
      const result = await this.client.callTool({ name, arguments: args });
      // result.content is an array of content blocks — concatenate text blocks
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      if (!content) return "";
      return content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, name }, "MCP tool call failed");
      // Return error as text so model can reason about it instead of throwing
      return `ERROR calling tool ${name}: ${msg}`;
    }
  }

  async dispose(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        log.warn({ err }, "Failed to close MCP client cleanly");
      }
      this.client = null;
    }
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.cachedTools = null;
  }
}
