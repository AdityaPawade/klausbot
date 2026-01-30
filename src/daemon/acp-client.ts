import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Bot } from 'grammy';
import { klausbotMcp } from '../mcp/index.js';
import { TelegramStreamer } from '../telegram/streamer.js';
import { buildSystemPrompt, KLAUSBOT_HOME } from '../memory/index.js';
import { createChildLogger } from '../utils/logger.js';
import type { MyContext } from '../telegram/bot.js';

const logger = createChildLogger('acp-client');

/** Response from ACP query */
export interface AcpResponse {
  result: string;
  cost_usd: number;
  session_id: string;
  duration_ms: number;
  is_error: boolean;
}

/** Options for ACP query */
export interface AcpOptions {
  /** Additional system prompt instructions */
  additionalInstructions?: string;
  /** Telegram bot for streaming */
  bot?: Bot<MyContext>;
  /** Chat ID for streaming (required if bot provided) */
  chatId?: number;
}

/**
 * Query Claude via Agent SDK with streaming to Telegram
 */
export async function queryWithStreaming(
  prompt: string,
  options: AcpOptions = {}
): Promise<AcpResponse> {
  const startTime = Date.now();
  let streamer: TelegramStreamer | null = null;

  // Set up streamer if bot and chatId provided
  if (options.bot && options.chatId) {
    streamer = new TelegramStreamer(options.chatId, options.bot);
  }

  // Build system prompt
  let systemPrompt = buildSystemPrompt();
  if (options.additionalInstructions) {
    systemPrompt += '\n\n' + options.additionalInstructions;
  }

  logger.info(
    { prompt: prompt.slice(0, 100), cwd: KLAUSBOT_HOME },
    'Starting ACP query'
  );

  let result = '';
  let cost_usd = 0;
  let session_id = '';
  let is_error = false;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: KLAUSBOT_HOME,
        mcpServers: { klausbot: klausbotMcp },
        allowedTools: [
          'mcp__klausbot__create_cron',
          'mcp__klausbot__list_crons',
          'mcp__klausbot__delete_cron',
          'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
        ],
        systemPrompt,
        permissionMode: 'bypassPermissions',
      },
    })) {
      // Check MCP server status on init
      if (message.type === 'system' && message.subtype === 'init') {
        const failed = message.mcp_servers?.filter(
          (s: { status: string }) => s.status !== 'connected'
        );
        if (failed?.length) {
          logger.warn({ failed }, 'MCP servers failed to connect');
        }
      }

      // Stream assistant text chunks
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block && typeof block.text === 'string') {
            result += block.text;
            if (streamer) {
              await streamer.addChunk(block.text);
            }
          }
        }
      }

      // Capture result metadata
      if (message.type === 'result') {
        cost_usd = message.total_cost_usd ?? 0;
        session_id = message.session_id ?? '';
        is_error = message.is_error ?? false;
        break;
      }
    }

    // Final flush
    if (streamer) {
      await streamer.flush();
    }

  } catch (err) {
    is_error = true;
    result = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'ACP query failed');
  }

  const duration_ms = Date.now() - startTime;
  logger.info(
    { duration_ms, cost_usd, session_id, is_error },
    'ACP query complete'
  );

  return { result, cost_usd, session_id, duration_ms, is_error };
}
