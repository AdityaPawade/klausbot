import { describe, expect, it } from "vitest";
import {
  containsMarkdown,
  escapeHtml,
  markdownToTelegramHtml,
  splitTelegramMessage,
} from "../../../src/utils/telegram-html.js";

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("no special chars")).toBe("no special chars");
  });

  it("escapes multiple entities in one string", () => {
    expect(escapeHtml("<b>a & b</b>")).toBe("&lt;b&gt;a &amp; b&lt;/b&gt;");
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b>", () => {
    const result = markdownToTelegramHtml("**bold**");
    expect(result).toContain("<b>bold</b>");
  });

  it("converts *italic* to <i>", () => {
    const result = markdownToTelegramHtml("*italic*");
    expect(result).toContain("<i>italic</i>");
  });

  it("converts `inline code` to <code>", () => {
    const result = markdownToTelegramHtml("`inline code`");
    expect(result).toContain("<code>inline code</code>");
  });

  it("converts fenced code block with language", () => {
    const md = '```js\nconsole.log("hi");\n```';
    const result = markdownToTelegramHtml(md);
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain("console.log");
  });

  it("converts fenced code block without language", () => {
    const md = "```\nplain code\n```";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("plain code");
  });

  it("converts [link](url) to <a>", () => {
    const result = markdownToTelegramHtml("[link](https://example.com)");
    expect(result).toContain('<a href="https://example.com">link</a>');
  });

  it("converts bullet list items with bullet chars", () => {
    const md = "- item1\n- item2";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("item1");
    expect(result).toContain("item2");
    // Should contain bullet character
    expect(result).toMatch(/[•\-]/);
  });

  it("converts ordered list with numbers", () => {
    const md = "1. first\n2. second";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("first");
    expect(result).toContain("second");
  });

  it("renders markdown table inside <pre> tag", () => {
    const md = "| Col1 | Col2 |\n| --- | --- |\n| a | b |";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<pre>");
    expect(result).toContain("Col1");
    expect(result).toContain("Col2");
  });

  it("converts # heading to <b>", () => {
    const result = markdownToTelegramHtml("# Title");
    expect(result).toContain("<b>Title</b>");
  });

  it("converts ## heading to <b>", () => {
    const result = markdownToTelegramHtml("## Subtitle");
    expect(result).toContain("<b>Subtitle</b>");
  });

  it("converts > blockquote to <blockquote>", () => {
    const result = markdownToTelegramHtml("> quote");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quote");
  });

  it("converts --- (hr) to separator", () => {
    const result = markdownToTelegramHtml("---");
    expect(result).toContain("———");
  });

  it("escapes HTML entities in regular text", () => {
    const result = markdownToTelegramHtml("a < b & c > d");
    expect(result).toContain("&lt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&gt;");
  });

  it("handles nested formatting (**bold *and italic*)**", () => {
    const result = markdownToTelegramHtml("**bold *and italic***");
    expect(result).toContain("<b>");
    expect(result).toContain("<i>");
  });
});

describe("containsMarkdown", () => {
  it("detects code blocks", () => {
    expect(containsMarkdown("```js\ncode\n```")).toBe(true);
  });

  it("detects inline code", () => {
    expect(containsMarkdown("use `npm install`")).toBe(true);
  });

  it("detects bold", () => {
    expect(containsMarkdown("this is **bold**")).toBe(true);
  });

  it("detects italic", () => {
    expect(containsMarkdown("this is *italic*")).toBe(true);
  });

  it("detects links", () => {
    expect(containsMarkdown("[click](https://example.com)")).toBe(true);
  });

  it("detects headings", () => {
    expect(containsMarkdown("# Title")).toBe(true);
  });

  it("detects blockquotes", () => {
    expect(containsMarkdown("> quote")).toBe(true);
  });

  it("detects tables", () => {
    expect(containsMarkdown("| col1 | col2 |")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(containsMarkdown("Just a plain sentence.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsMarkdown("")).toBe(false);
  });
});

describe("splitTelegramMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitTelegramMessage("Hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Hello world");
  });

  it("splits at paragraph boundary (double newline)", () => {
    const para1 = "A".repeat(3000);
    const para2 = "B".repeat(3000);
    const text = para1 + "\n\n" + para2;
    const result = splitTelegramMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("splits at sentence boundary when no paragraph break", () => {
    // One long paragraph with a sentence boundary
    const text = "A".repeat(3000) + ". " + "B".repeat(3000);
    const result = splitTelegramMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("respects custom maxLength parameter", () => {
    const text = "Hello world. This is a test. Another sentence here.";
    const result = splitTelegramMessage(text, 20);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(21); // +1 for boundary char
    }
  });

  it("handles empty string", () => {
    const result = splitTelegramMessage("");
    expect(result).toHaveLength(0);
  });

  it("handles text exactly at maxLength", () => {
    const text = "X".repeat(4096);
    const result = splitTelegramMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });
});
