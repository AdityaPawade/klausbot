/**
 * Cron execution eval suite
 *
 * Tests that cron job outputs are substantive (real content)
 * rather than mere acknowledgments like "ok" or "I'll do that".
 */

import { generateText } from "ai";
import { evalite } from "evalite";

import {
  createBehaviorScorer,
  createSubstantivenessScorer,
} from "./helpers/scorers.js";
import { judgeModel, taskModel } from "./helpers/model.js";
import { buildEvalSystemPrompt, buildCronPrompt } from "./helpers/prompts.js";

evalite<string, string, string>("Cron Output Quality", {
  data: () => [
    {
      input: "Daily Weather|Check weather in Kolkata and give a brief summary",
      expected:
        "Substantive weather summary with temperature, conditions, or forecast details",
    },
    {
      input:
        "News Digest|Summarize top 3 tech news stories in bullet point format",
      expected:
        "Bullet-pointed list of 3 tech news items with brief descriptions",
    },
    {
      input:
        "Reminder Check|Check upcoming deadlines and remind the user of anything due this week",
      expected:
        "A reminder message about upcoming deadlines or confirmation that none are due",
    },
  ],

  task: async (input) => {
    const [jobName, instruction] = input.split("|", 2);
    const { text } = await generateText({
      model: taskModel,
      system: buildEvalSystemPrompt(),
      prompt: buildCronPrompt(jobName, instruction),
    });
    return text;
  },

  scorers: [
    createSubstantivenessScorer(judgeModel),
    createBehaviorScorer(judgeModel),
  ],
});
