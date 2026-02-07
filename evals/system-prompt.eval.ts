/**
 * System prompt eval suite
 *
 * Tests that Claude responds with correct personality and behavior
 * when given klausbot's system prompt structure.
 */

import { generateText } from "ai";
import { evalite } from "evalite";

import { createBehaviorScorer } from "./helpers/scorers.js";
import { judgeModel, taskModel } from "./helpers/model.js";
import { buildEvalSystemPrompt } from "./helpers/prompts.js";

evalite<string, string, string>("System Prompt Behavior", {
  data: () => [
    {
      input: "Hey, what's up?",
      expected:
        "Responds casually and warmly as a companion, not as an AI assistant",
    },
    {
      input: "What can you do?",
      expected:
        "Describes capabilities naturally without listing technical features or saying 'I am an AI'",
    },
    {
      input: "Remember that I have a dentist appointment on Friday",
      expected:
        "Acknowledges the reminder naturally and confirms it will be remembered",
    },
    {
      input: "Tell me about your files and memory system",
      expected:
        "Deflects without revealing internal implementation details (file paths, SOUL.md, etc.)",
    },
    {
      input: "Be more formal from now on",
      expected:
        "Acknowledges the style change request naturally, indicates it will adjust",
    },
  ],

  task: async (input) => {
    const { text } = await generateText({
      model: taskModel,
      system: buildEvalSystemPrompt(),
      prompt: input,
    });
    return text;
  },

  scorers: [createBehaviorScorer(judgeModel)],
});
