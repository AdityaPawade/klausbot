/**
 * Hook CLI handlers for Claude Code integration
 * Receives JSON from stdin, processes session events
 */

import { stdin } from 'process';

/** Claude Code hook input structure */
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source?: string;  // SessionStart: 'startup' | 'resume' | 'clear' | 'compact'
  reason?: string;  // SessionEnd: exit reason
}

/**
 * Read JSON from stdin (non-blocking with timeout)
 */
async function readStdin(timeoutMs = 5000): Promise<HookInput> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('stdin timeout'));
    }, timeoutMs);

    stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        const json = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(json) as HookInput);
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err}`));
      }
    });

    stdin.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Handle SessionStart hook
 * Outputs context to stdout (injected into Claude session)
 */
export async function handleHookStart(): Promise<void> {
  const input = await readStdin();

  // Output current datetime for temporal context
  const datetime = new Date().toISOString();

  // Placeholder for conversation summaries (Plan 02 will implement)
  const context = `<session-context>
Current datetime: ${datetime}
Session ID: ${input.session_id}
</session-context>`;

  // Write to stdout - Claude adds this to context
  console.log(context);
}

/**
 * Handle PreCompact hook
 * Saves conversation state before context window compaction
 */
export async function handleHookCompact(): Promise<void> {
  const input = await readStdin();

  // Placeholder: Plan 02 will save conversation state
  // For now, just log to stderr (hooks should be quiet on stdout)
  console.error(`[hook:compact] session=${input.session_id}`);
}

/**
 * Handle SessionEnd hook
 * Copies transcript to storage, generates summary
 */
export async function handleHookEnd(): Promise<void> {
  const input = await readStdin();

  // Placeholder: Plan 02 will implement storage
  // For now, just log to stderr
  console.error(`[hook:end] session=${input.session_id} transcript=${input.transcript_path}`);
}
