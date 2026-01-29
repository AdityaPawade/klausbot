import { existsSync, readFileSync } from 'fs';
import { getHomePath } from './home.js';

/**
 * Cache identity content at startup to avoid blocking I/O per request
 * NOTE: Changes to identity files require process restart (acceptable for Phase 2)
 */
let identityCache: string | null = null;

/** Identity files to load from ~/.klausbot/identity/ */
const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;

/**
 * Load identity files from disk and cache
 * Wraps each file in XML tags: <FILENAME>\n{content}\n</FILENAME>
 *
 * @returns Concatenated identity content wrapped in XML tags
 */
export function loadIdentity(): string {
  // Return cached value on subsequent calls
  if (identityCache !== null) {
    return identityCache;
  }

  const parts: string[] = [];

  for (const filename of IDENTITY_FILES) {
    const path = getHomePath('identity', filename);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        parts.push(`<${filename}>\n${content}\n</${filename}>`);
      } catch {
        // Graceful degradation: skip unreadable files
      }
    }
  }

  identityCache = parts.join('\n\n');
  return identityCache;
}

/**
 * Build retrieval instructions for Claude's memory access
 * Tells Claude how to search conversations and update preferences
 *
 * @returns Memory instructions wrapped in XML tags
 */
export function getRetrievalInstructions(): string {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format

  return `<memory-instructions>
## Working Directory

Your working directory is ~/.klausbot/

## Available Files

- conversations/{date}.md - Daily conversation logs (e.g., conversations/${today}.md)
- identity/USER.md - Learned user preferences

## Retrieval Workflow

1. **Today's context:** Read conversations/${today}.md for current session context
2. **Historical search:** Use Grep tool to search conversations/ for past topics
3. **Important markers:** Look for [!important] markers in conversations for key information
4. **User preferences:** Check identity/USER.md for learned preferences

## Preference Learning

If user states a preference, update ~/.klausbot/identity/USER.md to record it.
Examples:
- "I prefer concise responses" -> Add to USER.md Preferences section
- "My timezone is EST" -> Add to USER.md Context section
- "Call me Alex" -> Add to USER.md Context section
</memory-instructions>`;
}

/**
 * Build the complete system prompt for Claude sessions
 * Combines identity files + retrieval instructions
 *
 * @returns Complete system prompt string
 */
export function buildSystemPrompt(): string {
  const identity = loadIdentity();
  const instructions = getRetrievalInstructions();

  // Combine with double newline separator
  return identity + '\n\n' + instructions;
}
