/**
 * Convert Markdown to Telegram HTML format
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>
 * See: https://core.telegram.org/bots/api#html-style
 *
 * Claude typically outputs standard Markdown which we convert here.
 */

/**
 * Escape HTML entities to prevent injection
 * Must be called BEFORE any HTML tags are added
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert Markdown to Telegram HTML
 *
 * Handles:
 * - Code blocks (```lang\ncode\n```) → <pre><code class="language-lang">
 * - Inline code (`code`) → <code>code</code>
 * - Bold (**text**) → <b>text</b>
 * - Italic (*text* or _text_) → <i>text</i>
 * - Links [text](url) → <a href="url">text</a>
 * - Headers (# Header) → <b>Header</b>
 * - Blockquotes (> text) → <blockquote>text</blockquote>
 *
 * @param markdown - Markdown text from Claude
 * @returns Telegram HTML formatted text
 */
export function markdownToTelegramHtml(markdown: string): string {
  // Store code blocks to protect them from other transformations
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Step 1: Extract and protect fenced code blocks
  let result = markdown.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const escapedCode = escapeHtml(code.trimEnd());
      const langAttr = lang ? ` class="language-${lang}"` : "";
      const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`);
      return placeholder;
    },
  );

  // Step 2: Extract and protect inline code
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Step 3: Escape remaining HTML entities
  result = escapeHtml(result);

  // Step 4: Convert headers (# Header → <b>Header</b>)
  // Handle h1-h6
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Step 5: Convert blockquotes (> text → <blockquote>text</blockquote>)
  // Handle multi-line blockquotes
  result = result.replace(
    /^&gt;\s*(.+)$/gm,
    "<blockquote>$1</blockquote>",
  );
  // Merge adjacent blockquotes
  result = result.replace(
    /<\/blockquote>\n<blockquote>/g,
    "\n",
  );

  // Step 6: Convert bold (**text** → <b>text</b>)
  // Use non-greedy match and handle multiline
  result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");

  // Step 7: Convert italic (*text* or _text_ → <i>text</i>)
  // Avoid matching ** (bold) or _ in words like snake_case
  // Only match *text* that's not part of **text**
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  // Match _text_ only at word boundaries
  result = result.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // Step 8: Convert links [text](url) → <a href="url">text</a>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Step 9: Restore inline code
  inlineCodes.forEach((code, i) => {
    result = result.replace(`__INLINE_CODE_${i}__`, code);
  });

  // Step 10: Restore code blocks
  codeBlocks.forEach((block, i) => {
    result = result.replace(`__CODE_BLOCK_${i}__`, block);
  });

  return result;
}

/**
 * Check if text contains markdown that would benefit from HTML parsing
 */
export function containsMarkdown(text: string): boolean {
  // Check for common markdown patterns
  return (
    /```[\s\S]*?```/.test(text) || // Code blocks
    /`[^`]+`/.test(text) || // Inline code
    /\*\*[^*]+\*\*/.test(text) || // Bold
    /(?<!\*)\*[^*]+\*(?!\*)/.test(text) || // Italic
    /\[[^\]]+\]\([^)]+\)/.test(text) || // Links
    /^#{1,6}\s+/m.test(text) || // Headers
    /^>\s+/m.test(text) // Blockquotes
  );
}
