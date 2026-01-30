/**
 * MCP server for klausbot
 * Exposes cron management tools via in-process MCP
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createCronTool, listCronsTool, deleteCronTool } from './tools/cron.js';

/**
 * In-process MCP server with klausbot tools
 * Server name is "klausbot" - tools are prefixed `mcp__klausbot__*`
 */
export const klausbotMcp = createSdkMcpServer({
  name: 'klausbot',
  version: '1.0.0',
  tools: [createCronTool, listCronsTool, deleteCronTool],
});
