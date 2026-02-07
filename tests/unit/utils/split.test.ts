import { describe, expect, it } from "vitest";
import { splitMessage } from "../../../src/utils/split.js";

describe("splitMessage", () => {
  it("returns single element for short text (< 4096)", () => {
    const text = "Hello world";
    const result = splitMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("returns single element for text exactly 4096 chars", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("splits at sentence boundary ('. ')", () => {
    // Build text ~8000 chars with a sentence boundary near the middle
    const sentence1 = "A".repeat(3000) + ". ";
    const sentence2 = "B".repeat(5000);
    const text = sentence1 + sentence2;
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // First chunk should end at or near the sentence boundary
    expect(result[0]).toContain(".");
  });

  it("splits at word boundary when no good sentence boundary", () => {
    // Text with spaces but no ". " in the first 4096 chars
    const words = Array(800).fill("hello").join(" "); // ~4800 chars
    const text = words + " " + "B".repeat(4000);
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Chunks should not start/end mid-word
    for (const chunk of result) {
      expect(chunk.trim()).toBe(chunk);
    }
  });

  it("hard splits at MAX_LENGTH when no spaces exist", () => {
    const text = "X".repeat(8000);
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    // splitIdx = MAX_LENGTH-1, slice(0, splitIdx+1) = slice(0, 4096)
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(8000 - 4096);
  });

  it("produces 3 chunks for ~12000 char text", () => {
    // Each sentence ~4500 chars, 3 sentences
    const sentence = "A".repeat(3800) + ". ";
    const text = sentence + sentence + sentence;
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("returns [''] for empty string", () => {
    const result = splitMessage("");
    expect(result).toEqual([""]);
  });

  it("all chunks are non-empty after split", () => {
    const text = "Word ".repeat(1500); // ~7500 chars
    const result = splitMessage(text);
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("all chunks are within 4096 char limit", () => {
    const text = "Hello world. This is a test. ".repeat(200); // ~5600 chars
    const result = splitMessage(text);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});
