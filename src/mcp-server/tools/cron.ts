/**
 * Cron MCP tools
 * Exposes create_cron, list_crons, delete_cron to Claude
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createCronJob, listCronJobs, deleteCronJob } from '../../cron/service.js';
import { parseSchedule } from '../../cron/parse.js';

/**
 * Register cron tools with MCP server
 */
export function registerCronTools(server: McpServer): void {
  // TODO: Tool implementations in Task 2
}
