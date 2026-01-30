/**
 * Cron MCP tools for creating, listing, and deleting scheduled tasks
 * Uses Claude Agent SDK tool() helper with Zod schemas
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { parseSchedule } from '../../cron/parse.js';
import { createCronJob, listCronJobs, deleteCronJob } from '../../cron/service.js';

/**
 * Create a new scheduled task
 * Parses natural language or cron expression schedules
 */
export const createCronTool = tool(
  'create_cron',
  'Create a scheduled task that runs at specified times',
  {
    name: z.string().describe('Human-readable job name'),
    schedule: z
      .string()
      .describe(
        "Schedule: cron expression, natural language (e.g., 'every day at 9am'), or interval (e.g., 'every 5 minutes')"
      ),
    instruction: z.string().describe('What Claude should do when job runs'),
    chatId: z.number().describe('Telegram chat ID for notifications'),
  },
  async ({ name, schedule, instruction, chatId }) => {
    const parsed = parseSchedule(schedule);

    if (!parsed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Could not parse schedule: ${schedule}`,
          },
        ],
      };
    }

    const job = createCronJob({
      name,
      schedule: parsed.schedule,
      instruction,
      chatId,
      humanSchedule: parsed.humanReadable,
    });

    const nextRun = job.nextRunAtMs ? new Date(job.nextRunAtMs).toISOString() : 'never';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Created cron job "${job.name}" (${job.id})\nSchedule: ${parsed.humanReadable}\nNext run: ${nextRun}`,
        },
      ],
    };
  }
);

/**
 * List all scheduled tasks for a chat
 */
export const listCronsTool = tool(
  'list_crons',
  'List all scheduled tasks for a chat',
  {
    chatId: z.number().describe('Telegram chat ID'),
  },
  async ({ chatId }) => {
    const jobs = listCronJobs(chatId);

    if (jobs.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No scheduled tasks found.',
          },
        ],
      };
    }

    const jobList = jobs.map((job) => ({
      id: job.id,
      name: job.name,
      humanSchedule: job.humanSchedule,
      enabled: job.enabled,
      nextRunAtMs: job.nextRunAtMs,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(jobList, null, 2),
        },
      ],
    };
  }
);

/**
 * Delete a scheduled task by ID
 */
export const deleteCronTool = tool(
  'delete_cron',
  'Delete a scheduled task',
  {
    id: z.string().describe('Job ID (UUID)'),
  },
  async ({ id }) => {
    const deleted = deleteCronJob(id);

    return {
      content: [
        {
          type: 'text' as const,
          text: deleted ? `Deleted job ${id}` : `Job ${id} not found`,
        },
      ],
    };
  }
);
