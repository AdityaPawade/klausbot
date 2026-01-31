/**
 * Capability detection for klausbot.
 *
 * Defines required and optional capabilities with their check functions.
 * Used by startup checklist to show what features are available.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Check if a command exists in PATH using Node APIs
 */
function commandExists(cmd: string): boolean {
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');

  for (const dir of pathDirs) {
    const fullPath = join(dir, cmd);
    if (existsSync(fullPath)) return true;
    // Check with .exe on Windows
    if (process.platform === 'win32' && existsSync(fullPath + '.exe')) return true;
  }
  return false;
}

/** Capability severity level */
export type Severity = 'required' | 'optional';

/** Capability check status */
export type Status = 'ok' | 'missing';

/** Capability definition */
export interface Capability {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether capability is required or optional */
  severity: Severity;
  /** Check function - returns status */
  check: () => Promise<Status> | Status;
  /** Hint for remediation if missing */
  hint: string;
}

/** Result of checking a capability */
export interface CheckResult {
  /** The capability that was checked */
  capability: Capability;
  /** The status of the check */
  status: Status;
}

/**
 * All capabilities for klausbot.
 * Order: required first, then optional.
 */
export const capabilities: Capability[] = [
  {
    id: 'telegram',
    name: 'Telegram Bot Token',
    severity: 'required',
    check: () => (process.env.TELEGRAM_BOT_TOKEN ? 'ok' : 'missing'),
    hint: 'Set TELEGRAM_BOT_TOKEN in environment or .env file',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    severity: 'required',
    check: () => {
      // Check if claude is in PATH using Node APIs
      if (!commandExists('claude')) return 'missing';
      try {
        // Verify it responds
        execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
        return 'ok';
      } catch {
        return 'missing';
      }
    },
    hint: 'Install Claude Code: https://claude.ai/code',
  },
  {
    id: 'openai',
    name: 'OpenAI API (search_memory)',
    severity: 'optional',
    check: () => (process.env.OPENAI_API_KEY ? 'ok' : 'missing'),
    hint: 'Set OPENAI_API_KEY for semantic memory search',
  },
];

/**
 * Check all capabilities and return results.
 *
 * @returns Array of CheckResult for each capability
 */
export async function checkAllCapabilities(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const capability of capabilities) {
    const status = await capability.check();
    results.push({ capability, status });
  }

  return results;
}
