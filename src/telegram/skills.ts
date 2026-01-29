import { readdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Bot } from 'grammy';

/** Telegram bot command shape (for setMyCommands) */
interface BotCommand {
  command: string;
  description: string;
}
import type { MyContext } from './bot.js';
import { createChildLogger } from '../utils/index.js';

const log = createChildLogger('telegram:skills');

/** Default location for Claude Code skills */
const SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * Get list of installed skill names from ~/.claude/skills/
 * A valid skill is a directory containing SKILL.md
 */
export function getInstalledSkillNames(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];

  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name);
}

/**
 * Get skill description from SKILL.md frontmatter
 * Falls back to skill name if description not found
 */
export function getSkillDescription(name: string): string {
  const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(skillPath)) return name;

  try {
    const content = readFileSync(skillPath, 'utf-8');
    // Extract description from YAML frontmatter
    const match = content.match(/^---\n[\s\S]*?description:\s*(.+)/m);
    if (match) {
      // Telegram limits command descriptions to 256 chars
      return match[1].trim().slice(0, 250);
    }
  } catch {
    // Ignore read errors, fall back to name
  }

  return name;
}

/**
 * Register bot commands with Telegram menu
 * Skills not registered as commands (hyphens not allowed in Telegram commands)
 * Users invoke skills via: /skill <name> [args]
 */
export async function registerSkillCommands(bot: Bot<MyContext>): Promise<void> {
  const skillNames = getInstalledSkillNames();

  // Built-in commands only - skills invoked via /skill <name>
  const builtins: BotCommand[] = [
    { command: 'start', description: 'Start or check pairing' },
    { command: 'help', description: 'Show available commands' },
    { command: 'status', description: 'Show queue status' },
    { command: 'skill', description: 'Run skill: /skill <name> [args]' },
  ];

  await bot.api.setMyCommands(builtins);

  log.info(
    { builtins: builtins.length, skills: skillNames },
    'Registered Telegram commands'
  );
}
