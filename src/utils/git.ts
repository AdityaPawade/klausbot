import { spawn } from 'child_process';
import { createChildLogger } from './logger.js';

const log = createChildLogger('git');

/**
 * Run a git command and return output
 */
async function runGit(
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const git = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    git.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    git.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    git.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    git.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

/**
 * Auto-commit any uncommitted changes after Claude response
 * Satisfies EVOL-04: all self-modifications version controlled
 *
 * @returns true if changes were committed, false otherwise
 */
export async function autoCommitChanges(): Promise<boolean> {
  // Check if in git repo
  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree']);
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    log.warn('Not in a git repository, skipping auto-commit');
    return false;
  }

  // Check for changes
  const status = await runGit(['status', '--porcelain']);
  if (status.code !== 0) {
    log.warn({ stderr: status.stderr }, 'Failed to check git status');
    return false;
  }

  // No changes
  if (!status.stdout.trim()) {
    log.debug('No changes to commit');
    return false;
  }

  // Count changed files
  const changedFiles = status.stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim()).length;

  log.info({ files: changedFiles }, 'Staging changes');

  // Stage all changes
  const add = await runGit(['add', '-A']);
  if (add.code !== 0) {
    log.warn({ stderr: add.stderr }, 'Failed to stage changes');
    return false;
  }

  // Create commit with timestamp
  const timestamp = new Date().toISOString();
  const commitMsg = `chore(klausbot): auto-commit Claude modifications\n\nTimestamp: ${timestamp}`;

  const commit = await runGit(['commit', '-m', commitMsg]);
  if (commit.code !== 0) {
    // Check if it's just "nothing to commit"
    if (commit.stdout.includes('nothing to commit')) {
      log.debug('Nothing to commit after staging');
      return false;
    }
    log.warn({ stderr: commit.stderr }, 'Failed to create commit');
    return false;
  }

  log.info({ files: changedFiles, timestamp }, 'Committed changes');
  return true;
}
