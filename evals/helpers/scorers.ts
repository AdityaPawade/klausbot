/**
 * Custom scorers for klausbot evals.
 *
 * LLM-judge scorers use generateText to ask Claude to rate outputs.
 * Deterministic scorers use exact string comparison.
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { createScorer } from "evalite";

/**
 * LLM-judge scorer: rates how well output matches expected behavior.
 * Prompts judge to score 0-100, normalizes to 0-1.
 */
export function createBehaviorScorer(model: LanguageModelV2) {
  return createScorer<string, string, string>({
    name: "behavior-match",
    description: "LLM judge rates how well output matches expected behavior",
    scorer: async ({ input, output, expected }) => {
      try {
        const { text } = await generateText({
          model,
          prompt: `Given the user input and expected behavior description, rate how well the output matches on a scale of 0-100.

Input: ${input}
Expected behavior: ${expected}
Actual output: ${output}

Return ONLY a number 0-100.`,
        });

        const parsed = parseInt(text.trim(), 10);
        if (isNaN(parsed)) {
          return { score: 0.5, metadata: { error: "parse-failed", raw: text } };
        }
        const clamped = Math.max(0, Math.min(100, parsed));
        return { score: clamped / 100, metadata: { judgeResponse: text } };
      } catch (err) {
        return {
          score: 0.5,
          metadata: {
            error: "judge-failed",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  });
}

/**
 * Deterministic scorer: 1.0 if output exactly matches expected string.
 */
export function createExactMatchScorer(expected: string) {
  return createScorer<string, string, string>({
    name: "exact-match",
    description: `Exact match against "${expected}"`,
    scorer: ({ output }) => {
      return output.trim() === expected ? 1.0 : 0.0;
    },
  });
}

/**
 * Deterministic scorer: 1.0 if output does NOT match forbidden string.
 */
export function createNotExactScorer(forbidden: string) {
  return createScorer<string, string, string>({
    name: "not-exact-match",
    description: `Must not exactly match "${forbidden}"`,
    scorer: ({ output }) => {
      return output.trim() !== forbidden ? 1.0 : 0.0;
    },
  });
}

/**
 * LLM-judge scorer: rates whether cron output is substantive
 * (real content, not just "ok" or "I'll do that").
 */
export function createSubstantivenessScorer(model: LanguageModelV2) {
  return createScorer<string, string, string>({
    name: "substantiveness",
    description:
      "LLM judge rates whether output is substantive vs mere acknowledgment",
    scorer: async ({ output }) => {
      try {
        const { text } = await generateText({
          model,
          prompt: `Rate whether this cron job output is substantive and actionable (contains real content, not just acknowledgment like "ok", "done", "I'll do that"). Score 0-100.

Output: ${output}

Return ONLY a number 0-100.`,
        });

        const parsed = parseInt(text.trim(), 10);
        if (isNaN(parsed)) {
          return { score: 0.5, metadata: { error: "parse-failed", raw: text } };
        }
        const clamped = Math.max(0, Math.min(100, parsed));
        return { score: clamped / 100, metadata: { judgeResponse: text } };
      } catch (err) {
        return {
          score: 0.5,
          metadata: {
            error: "judge-failed",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  });
}
