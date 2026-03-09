/**
 * Project brief management — per-project BRIEF.md files.
 * Each project has a BRIEF.md describing what it does, its domain,
 * target market, tech stack, and search keywords for rumination scanning.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { KLAUSBOT_HOME } from "../memory/home.js";
import { listProjects, getProjectHome } from "../memory/project.js";

/** Template for auto-generated BRIEF.md */
const BRIEF_TEMPLATE = `# Project Brief

## What This Project Does
(Describe the project in 2-3 sentences)

## Domain & Market
(What industry/market does this target?)

## Tech Stack
(Key technologies, languages, frameworks)

## Search Keywords
(Keywords for market scanning: competitors, technologies, standards, domains)

## Active Challenges
(Current problems or areas of focus)
`;

/**
 * Get the BRIEF.md path for a specific project.
 * @param projectName - project name, or null for global
 */
export function getBriefPath(projectName: string | null): string {
  if (projectName) {
    return join(getProjectHome(projectName), "identity", "BRIEF.md");
  }
  return join(KLAUSBOT_HOME, "identity", "BRIEF.md");
}

/**
 * Read a project's BRIEF.md content.
 * @returns content string, or null if file doesn't exist
 */
export function readBrief(projectName: string | null): string | null {
  const briefPath = getBriefPath(projectName);
  if (!existsSync(briefPath)) return null;

  try {
    return readFileSync(briefPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read all project briefs across all projects + global.
 * Skips projects without a BRIEF.md.
 */
export function readAllBriefs(): Array<{
  project: string;
  content: string;
}> {
  const briefs: Array<{ project: string; content: string }> = [];

  // Global brief
  const globalBrief = readBrief(null);
  if (globalBrief) {
    briefs.push({ project: "global", content: globalBrief });
  }

  // Per-project briefs
  for (const projectName of listProjects()) {
    const brief = readBrief(projectName);
    if (brief) {
      briefs.push({ project: projectName, content: brief });
    }
  }

  return briefs;
}

/**
 * Ensure a project has a BRIEF.md file.
 * If missing, auto-generates from USER.md content or creates a template.
 */
export function ensureBrief(projectName: string | null): void {
  const briefPath = getBriefPath(projectName);
  if (existsSync(briefPath)) return;

  // Try to seed from USER.md
  const userMdPath = projectName
    ? join(getProjectHome(projectName), "identity", "USER.md")
    : join(KLAUSBOT_HOME, "identity", "USER.md");

  let content = BRIEF_TEMPLATE;

  if (existsSync(userMdPath)) {
    try {
      const userMd = readFileSync(userMdPath, "utf-8");
      if (userMd.trim()) {
        content =
          `# Project Brief\n\n` +
          `> Auto-generated from USER.md. Edit to add domain, market, and search keywords.\n\n` +
          `## User Context\n\n${userMd.trim()}\n\n` +
          `## Domain & Market\n(What industry/market does this target?)\n\n` +
          `## Search Keywords\n(Keywords for market scanning: competitors, technologies, standards, domains)\n`;
      }
    } catch {
      // Fall through to template
    }
  }

  writeFileSync(briefPath, content);
}
