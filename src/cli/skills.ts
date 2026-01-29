/**
 * Skills CLI module
 *
 * Provides commands for installing and managing Claude skills.
 * Auto-installs skill-creator on gateway startup.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { select } from '@inquirer/prompts';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('cli:skills');
const SKILLS_DIR = join(homedir(), '.claude', 'skills');

// GitHub API base for anthropics/skills repo
const GITHUB_API = 'https://api.github.com/repos/anthropics/skills/contents/skills';

/** Curated skills available for installation */
const CURATED_SKILLS = [
  {
    name: 'skill-creator',
    description: 'Create new skills interactively (Anthropic official)',
    mandatory: true,
  },
] as const;

/** GitHub API content item shape */
interface GitHubContentItem {
  name: string;
  type: string;
  download_url: string | null;
  path: string;
}

/**
 * Install a subdirectory of a skill recursively
 */
async function installSubdir(
  baseDir: string,
  subpath: string,
  skillName: string
): Promise<void> {
  const subDir = join(baseDir, subpath);
  mkdirSync(subDir, { recursive: true });

  const res = await fetch(`${GITHUB_API}/${skillName}/${subpath}`);
  if (!res.ok) return;

  const contents = (await res.json()) as GitHubContentItem[];

  for (const item of contents) {
    if (item.type === 'file' && item.download_url) {
      const fileRes = await fetch(item.download_url);
      if (fileRes.ok) {
        writeFileSync(join(subDir, item.name), await fileRes.text());
      }
    } else if (item.type === 'dir') {
      await installSubdir(baseDir, `${subpath}/${item.name}`, skillName);
    }
  }
}

/**
 * Install a skill folder from GitHub (recursive, includes all files)
 */
async function installSkillFolder(name: string): Promise<void> {
  const skillDir = join(SKILLS_DIR, name);
  mkdirSync(skillDir, { recursive: true });

  // Fetch folder contents from GitHub API
  const res = await fetch(`${GITHUB_API}/${name}`);
  if (!res.ok) throw new Error(`Failed to list ${name}: ${res.status}`);

  const contents = (await res.json()) as GitHubContentItem[];

  // Download each file/folder recursively
  for (const item of contents) {
    if (item.type === 'file' && item.download_url) {
      const fileRes = await fetch(item.download_url);
      if (!fileRes.ok) throw new Error(`Failed to fetch ${item.name}`);
      writeFileSync(join(skillDir, item.name), await fileRes.text());
    } else if (item.type === 'dir') {
      // Recursively fetch subdirectory
      await installSubdir(skillDir, item.path.replace(`skills/${name}/`, ''), name);
    }
  }

  log.info({ skill: name }, 'Skill installed');
}

/**
 * Ensure skill-creator is installed
 * Called on gateway startup to auto-install mandatory skill
 */
export async function ensureSkillCreator(): Promise<void> {
  const skillPath = join(SKILLS_DIR, 'skill-creator', 'SKILL.md');
  if (existsSync(skillPath)) return;

  log.info('Installing skill-creator...');
  await installSkillFolder('skill-creator');
}

/**
 * Get list of installed skills
 * A skill is installed if its folder contains SKILL.md
 */
function getInstalledSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name);
}

/**
 * Run the skills CLI
 * Shows installed skills and provides option to install curated skills
 */
export async function runSkillsCLI(): Promise<void> {
  const installed = getInstalledSkills();

  console.log('\n=== Installed Skills ===');
  if (installed.length === 0) {
    console.log('(none)');
  } else {
    installed.forEach((s) => console.log(`  - ${s}`));
  }
  console.log();

  const notInstalled = CURATED_SKILLS.filter((s) => !installed.includes(s.name));

  if (notInstalled.length === 0) {
    console.log('All curated skills installed.');
    return;
  }

  const choice = await select({
    message: 'Install a skill?',
    choices: [
      ...notInstalled.map((s) => ({ name: `${s.name} - ${s.description}`, value: s.name })),
      { name: 'Exit', value: 'exit' },
    ],
  });

  if (choice === 'exit') return;

  const skill = CURATED_SKILLS.find((s) => s.name === choice);
  if (skill) {
    console.log(`Installing ${skill.name}...`);
    await installSkillFolder(skill.name);
    console.log(`Installed: ${skill.name}`);
  }
}
