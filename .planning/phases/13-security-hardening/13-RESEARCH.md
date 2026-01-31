# Phase 13: Security Hardening - Research

**Researched:** 2026-01-31
**Domain:** Input validation, prompt injection prevention, log redaction
**Confidence:** MEDIUM (established patterns, some domain-specific adaptation needed)

## Summary

Security hardening for klausbot requires three complementary defenses:

1. **Input sanitization** - Validate and sanitize user prompts before passing to Claude Code
2. **Injection prevention** - Detect and reject malicious patterns that attempt to manipulate Claude
3. **Log redaction** - Prevent sensitive data (pairing codes, tokens) from appearing in logs

**Key insight:** Prompt injection in LLM systems differs from traditional injection attacks. The goal isn't SQL/XSS - it's manipulating the AI's behavior. Defense-in-depth applies: assume any single layer can fail.

**Primary recommendation:** Use Zod for input validation, pino's built-in redaction for sensitive data, and containment strategy (Claude Code sandbox) as the final safety net.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^4.3.6 | Schema-based input validation | Already in project, type-safe, safeParse for error handling |
| pino | ^9.6.0 | Logger with redaction | Already in project, built-in redaction with path syntax |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | All requirements covered by existing deps |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Built-in pino redaction | pino-noir | Extra dep, but more flexible patterns |
| Zod validation | express-validator | Different paradigm, Zod already used |
| Custom regex filters | LLM-Guard | Overkill for personal bot, adds latency |

**Installation:**
```bash
# No new packages needed - zod and pino already present
```

## Architecture Patterns

### Recommended Project Structure

```
src/
├── security/              # NEW: Security module
│   ├── index.ts           # Re-exports
│   ├── validation.ts      # Input validation schemas + sanitizer
│   ├── redaction.ts       # Pino redaction config
│   └── patterns.ts        # Injection detection patterns
├── utils/
│   └── logger.ts          # MODIFY: Add redaction config
```

### Pattern 1: Layered Input Validation

**What:** Sequential validation pipeline: type check → sanitize → injection detect
**When to use:** Every user message before passing to Claude

```typescript
// Source: Zod docs + OWASP LLM cheatsheet patterns
import { z } from 'zod';

// Schema for user prompt input
const userPromptSchema = z.string()
  .min(1, 'Empty message')
  .max(10000, 'Message too long')  // Reasonable limit
  .trim()
  .refine(
    (val) => !containsInjectionPattern(val),
    { message: 'Input rejected' }  // Generic error, no details
  );

function validatePrompt(input: unknown): { success: true; data: string } | { success: false; error: string } {
  const result = userPromptSchema.safeParse(input);
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message ?? 'Invalid input' };
  }
  return { success: true, data: result.data };
}
```

### Pattern 2: Injection Detection (Heuristic)

**What:** Pattern matching for common prompt injection techniques
**When to use:** Within validation pipeline, before Claude

```typescript
// Source: OWASP LLM Prompt Injection Cheatsheet
const INJECTION_PATTERNS: RegExp[] = [
  // Direct instruction override
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  // Role manipulation
  /you\s+are\s+(now|a)\s+(different|new|an?\s+evil|malicious)/i,
  // System prompt extraction
  /print\s+(your|the)?\s*(system|initial)\s*(prompt|instructions?)/i,
  /reveal\s+(your|the)?\s*(system|hidden)\s*(prompt|instructions?)/i,
  // Developer/debug mode
  /developer\s+mode|debug\s+mode|admin\s+mode/i,
  // Jailbreak markers
  /\[DAN\]|\[JAILBREAK\]|DUDE\s*:/i,
];

function containsInjectionPattern(text: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(text));
}
```

### Pattern 3: Pino Redaction Configuration

**What:** Declarative sensitive data masking at logger level
**When to use:** Logger initialization

```typescript
// Source: pino redaction docs
import pino from 'pino';

const redactionConfig = {
  paths: [
    'code',              // Pairing codes
    '*.code',            // Nested pairing codes
    'token',             // API tokens
    '*.token',
    'password',
    '*.password',
    'apiKey',
    '*.apiKey',
    'TELEGRAM_BOT_TOKEN',
    'OPENAI_API_KEY',
  ],
  censor: '[REDACTED]',
};

const logger = pino({
  level: config.LOG_LEVEL,
  redact: redactionConfig,
  // ... other options
});
```

### Pattern 4: Containment Strategy

**What:** Assume validation will fail; limit blast radius
**When to use:** Claude Code invocation configuration

The project already uses `--dangerously-skip-permissions` with Claude Code. Containment options:

1. **Claude Code Sandbox** (if available): Use `/sandbox` mode
2. **Working Directory Isolation:** Already uses `KLAUSBOT_HOME` as cwd - Claude can only modify within `~/.klausbot/`
3. **MCP Tool Restrictions:** Current MCP tools are read-heavy (search_memories, get_conversation)

### Anti-Patterns to Avoid

- **Revealing detection:** Never tell user why input was rejected ("injection detected")
- **Denylist-only:** Attackers find new patterns; use allowlist where possible
- **Logging rejected input verbatim:** Could still contain sensitive data
- **Trusting length limits alone:** Short prompts can still be malicious

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| String validation | Manual regex chain | Zod schemas | Type safety, composable, error messages |
| Log redaction | Manual search-replace | Pino redaction | Performance-optimized, path wildcards |
| Encoding detection | Custom base64/hex checks | Simple blocklist | Diminishing returns for personal bot |
| LLM-specific guardrails | Custom ML classifiers | None (overkill) | Personal bot, not enterprise |

**Key insight:** For a personal Telegram bot, sophisticated ML-based detection is overkill. Pattern matching + containment provides sufficient protection.

## Common Pitfalls

### Pitfall 1: Over-Logging During Development

**What goes wrong:** Developers add verbose logging with full objects during debug, forget to remove
**Why it happens:** Convenient for troubleshooting, no immediate consequence
**How to avoid:** Configure redaction from day 1; never log full objects with sensitive fields
**Warning signs:** Any log statement with `{ ...obj }` or full context objects

### Pitfall 2: False Positives on Legitimate Input

**What goes wrong:** User says "ignore my previous message" and gets blocked
**Why it happens:** Overly aggressive pattern matching
**How to avoid:** Test patterns against conversational phrases; require multiple signals
**Warning signs:** Users complaining about "rejected" messages for normal conversation

### Pitfall 3: Incomplete Wildcard Coverage

**What goes wrong:** Redaction works for `code` but not `pairing.code` or `msg.code`
**Why it happens:** Forgot to add wildcard pattern `*.code`
**How to avoid:** Use both direct paths and wildcard variants
**Warning signs:** Sensitive data appearing in logs despite "redaction"

### Pitfall 4: Redaction Bypass via Object Nesting

**What goes wrong:** `{ user: { credentials: { code: "ABC123" } } }` not redacted
**Why it happens:** Pino redaction requires explicit path depth
**How to avoid:** Add multi-level wildcards or restructure log calls
**Warning signs:** Test with deeply nested objects during development

### Pitfall 5: Prompt Injection via Media

**What goes wrong:** User sends image with embedded text instructions
**Why it happens:** Only validating text, not transcribed/extracted content
**How to avoid:** Validate ALL text including transcripts, image analysis results
**Warning signs:** Voice/image messages bypass validation

## Code Examples

### Complete Validation Pipeline

```typescript
// src/security/validation.ts
import { z } from 'zod';
import { INJECTION_PATTERNS } from './patterns.js';

const MAX_PROMPT_LENGTH = 10000;

// Schema with sanitization
const promptSchema = z.string()
  .min(1, 'Empty message')
  .max(MAX_PROMPT_LENGTH, 'Message too long')
  .trim()
  .transform((val) => {
    // Normalize unicode whitespace
    return val.replace(/[\u200B-\u200D\uFEFF]/g, '');
  })
  .refine(
    (val) => !hasInjectionSignals(val),
    { message: 'Invalid input' }
  );

function hasInjectionSignals(text: string): boolean {
  // Require 2+ pattern matches to reduce false positives
  let matchCount = 0;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

export function validateAndSanitize(
  input: unknown
): { ok: true; prompt: string } | { ok: false; error: string } {
  const result = promptSchema.safeParse(input);
  if (!result.success) {
    // Generic error - don't reveal what triggered rejection
    return { ok: false, error: 'Please try rephrasing your message' };
  }
  return { ok: true, prompt: result.data };
}
```

### Redaction-Enabled Logger

```typescript
// Modification to src/utils/logger.ts
const REDACT_PATHS = [
  // Pairing codes (most common sensitive data)
  'code',
  '*.code',
  'result',  // requestPairing returns code as 'result'

  // Tokens (shouldn't be logged, but safety net)
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',

  // Catch-all for common sensitive field names
  'password',
  '*.password',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
];

const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // ... rest of config
});
```

### Integration Point in Gateway

```typescript
// Modification to src/daemon/gateway.ts processMessage()
import { validateAndSanitize } from '../security/index.js';

async function processMessage(msg: QueuedMessage): Promise<void> {
  // Validate before any processing
  const validation = validateAndSanitize(msg.text);
  if (!validation.ok) {
    await bot.api.sendMessage(msg.chatId, validation.error);
    queue.complete(msg.id);  // Mark done, not failed
    return;
  }

  // Use sanitized prompt
  const sanitizedText = validation.prompt;
  // ... rest of processing with sanitizedText
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Denylist regex | Multi-signal detection | 2024-2025 | Reduces false positives |
| Manual log scrubbing | Structured logger redaction | 2020+ | Systematic, less error-prone |
| Trust user input | Assume hostile input | Always | Defense in depth |

**Deprecated/outdated:**
- **LLM-specific injection detection models:** Overkill for personal bot scale
- **Character-level filtering:** Too aggressive, breaks legitimate input
- **Relying solely on LLM safety:** Models can be jailbroken; external validation needed

## Open Questions

1. **Voice message transcripts**
   - What we know: Transcripts are generated via OpenAI Whisper
   - What's unclear: Should transcripts also be injection-checked?
   - Recommendation: YES - same validation pipeline for all text sources

2. **Image text extraction**
   - What we know: Claude analyzes images directly
   - What's unclear: Can embedded text in images inject prompts?
   - Recommendation: Accept risk - Claude's safety training covers this; OCR validation adds latency

3. **Pairing code in CLI output**
   - What we know: CLI shows pairing codes to admin
   - What's unclear: Is CLI output considered "logs"?
   - Recommendation: NO - CLI is direct admin output, not persistent logs

## Sources

### Primary (HIGH confidence)

- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md) - Path syntax, censor options
- [Zod documentation](https://zod.dev/) - safeParse, refine, trim methods
- Existing codebase analysis - Current logging patterns, input flow

### Secondary (MEDIUM confidence)

- [OWASP LLM Prompt Injection Cheatsheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) - Pattern detection, containment
- [Anthropic Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) - Containment strategy
- [Better Stack Pino Guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) - Redaction best practices

### Tertiary (LOW confidence)

- WebSearch results on "LLM security 2026" - General trends, need validation against official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Using existing deps (zod, pino)
- Architecture: MEDIUM - Patterns adapted from OWASP for LLM context
- Pitfalls: MEDIUM - Based on general security experience + LLM-specific research

**Research date:** 2026-01-31
**Valid until:** 2026-03-01 (LLM security evolving; review monthly)

---

## Current Codebase Findings

### Sensitive Data Currently Logged

| File | Line | Data | Risk |
|------|------|------|------|
| `src/pairing/store.ts:118` | `{ code, chatId }` | Pairing code | HIGH - appears in logs |
| `src/pairing/store.ts:132` | `{ code, chatId }` | Pairing code | HIGH |
| `src/pairing/store.ts:159` | `{ code, chatId }` | Pairing code | HIGH |
| `src/pairing/store.ts:177` | `{ code, chatId }` | Pairing code | HIGH |
| `src/pairing/flow.ts:65` | `{ code: result }` | Pairing code | HIGH |

### Current Input Flow (No Validation)

```
User message (Telegram)
  → bot.on('message:text') in gateway.ts
  → queue.add(chatId, text)  // Raw text, no validation
  → processMessage()
  → queryClaudeCode(effectiveText)  // Still raw
```

### Existing Containment (Partial)

- Claude Code runs with `cwd: KLAUSBOT_HOME` (~/.klausbot/)
- MCP tools are limited to memory search/retrieval
- BUT: `--dangerously-skip-permissions` gives Claude broad access

### Zod Already in Use

- `src/config/schema.ts` - Environment validation with Zod
- Same patterns can be extended for input validation
