import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { formatTaskTimestamp } from "./targets.js";

export interface SeedPromptTargetOptions {
  cwd: string;
  promptText: string;
  now: Date;
}

export interface SeedPromptTargetResult {
  taskDir: string;
  planFilePath: string;
  progressFilePath: string;
}

const MAX_INVESTIGATION_FILES = 60;
const MAX_INVESTIGATION_DEPTH = 5;
const MAX_RELEVANT_FILES = 12;
const INVESTIGATION_ROOTS = ["src", "__tests__"] as const;
const ROOT_INVESTIGATION_FILES = ["package.json", "Makefile", "README.md"];
const PROMPT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "coverage",
  "feature",
  "for",
  "from",
  "improve",
  "into",
  "new",
  "plan",
  "prompt",
  "ralph",
  "task",
  "the",
  "this",
  "with",
]);
const SKIP_DIRS = new Set([
  ".git",
  ".jj",
  ".agents",
  "node_modules",
  "dist",
  "coverage",
]);

function extractPromptTokens(promptText: string): string[] {
  return promptText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function promptTaskSlug(promptText: string): string {
  const [primary = "prompt", secondary = "plan"] =
    extractPromptTokens(promptText);

  return `${primary}-${secondary}`;
}

function walkFilesForInvestigation(
  baseDir: string,
  currentDir: string,
  discovered: string[],
  depth = 0,
): void {
  if (
    depth > MAX_INVESTIGATION_DEPTH ||
    discovered.length >= MAX_INVESTIGATION_FILES
  ) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (discovered.length >= MAX_INVESTIGATION_FILES) {
      return;
    }

    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      walkFilesForInvestigation(baseDir, absolutePath, discovered, depth + 1);
      continue;
    }

    if (entry.isFile()) {
      discovered.push(relative(baseDir, absolutePath));
    }
  }
}

function gatherInitialInvestigationPaths(cwd: string): string[] {
  const discovered: string[] = [];

  for (const rootFile of ROOT_INVESTIGATION_FILES) {
    if (existsSync(resolve(cwd, rootFile))) {
      discovered.push(rootFile);
    }
  }

  for (const root of INVESTIGATION_ROOTS) {
    walkFilesForInvestigation(cwd, resolve(cwd, root), discovered);
  }

  return discovered.slice(0, MAX_INVESTIGATION_FILES);
}

function selectRelevantInvestigationPaths(
  promptText: string,
  investigationPaths: string[],
): string[] {
  const keywords = Array.from(
    new Set(
      extractPromptTokens(promptText).filter((word) => {
        return word.length >= 3 && !PROMPT_STOP_WORDS.has(word);
      }),
    ),
  );
  if (keywords.length === 0) {
    return investigationPaths.slice(0, MAX_RELEVANT_FILES);
  }

  const scored = investigationPaths
    .map((path) => {
      const lowerPath = path.toLowerCase();
      const score = keywords.reduce((total, keyword) => {
        if (!lowerPath.includes(keyword)) {
          return total;
        }

        const exactSegment = lowerPath
          .split(/[/.\\-]/)
          .some((segment) => segment === keyword);

        return total + (exactSegment ? 4 : 2);
      }, 0);

      return { path, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      return right.score - left.score || left.path.localeCompare(right.path);
    })
    .map((entry) => entry.path);

  return (scored.length > 0 ? scored : investigationPaths).slice(
    0,
    MAX_RELEVANT_FILES,
  );
}

function toIndentedBulletLines(paths: string[]): string[] {
  return paths.length > 0
    ? paths.map((path) => `  - ${path}`)
    : ["  - (none discovered)"];
}

function buildPromptPlanTemplate(
  promptText: string,
  investigationPaths: string[],
): string {
  const normalizedPrompt = promptText.trim();
  const relevantPaths = selectRelevantInvestigationPaths(
    normalizedPrompt,
    investigationPaths,
  );
  const rootMarkers = ROOT_INVESTIGATION_FILES.filter((path) => {
    return investigationPaths.includes(path);
  });

  return [
    "# Plan: Ralph prompt",
    "",
    "## Goal",
    "Use one prompt-synthesis pass to turn the original user prompt into a detailed, repo-aware Ralph execution plan saved in this same `plan.md`.",
    "",
    "## Original User Prompt",
    normalizedPrompt || "(missing prompt text)",
    "",
    "## Meta-pass Deliverable",
    "- Rewrite `plan.md` into detailed, self-contained Ralph execution plan for later `/ralph <plan.md>` use.",
    "- Preserve explicit user constraints from the original prompt.",
    "- Do not implement underlying repository task yet.",
    "- Leave `progress.md` minimal.",
    "",
    "## Initial Investigation",
    "- Workspace scan used only local filesystem data.",
    "- Likely relevant files from prompt keywords:",
    ...toIndentedBulletLines(relevantPaths),
    "- Additional project markers discovered:",
    ...toIndentedBulletLines(rootMarkers),
    "",
    "## Requirements For Rewritten Plan",
    "- Preserve explicit user constraints while rewriting the prompt into actionable Ralph tasks.",
    "- Make the final plan self-contained so later `/ralph <plan.md>` execution does not need this meta-pass context.",
    "- Keep scope, acceptance checks, and likely file targets explicit per iteration.",
    "- Call out any referenced external repositories or local paths that later execution should inspect.",
    "",
    "## Meta-pass Rules",
    "- Read code and docs needed to understand the request before rewriting the plan.",
    "- Rewrite `plan.md` only; avoid unrelated repository changes.",
    "- Leave `progress.md` minimal so later `/ralph <plan.md>` execution starts cleanly.",
    "- Do not create implementation commits during this prompt-synthesis pass.",
    "",
    "## Completion Criteria",
    "- Rewritten `plan.md` is detailed enough to execute as a full `/ralph <plan.md>` loop.",
    "- The plan is self-contained and no longer depends on this original chat message.",
    "",
  ].join("\n");
}

function buildPromptProgressTemplate(): string {
  return [
    "# Progress: Ralph prompt",
    "",
    "## Status",
    "in progress",
    "",
    "## Iterations",
    "- Reserved for later `/ralph <plan.md>` execution history.",
    "",
  ].join("\n");
}

export function seedPromptTarget(
  options: SeedPromptTargetOptions,
): SeedPromptTargetResult {
  const taskDir = resolve(
    options.cwd,
    ".agents",
    "plans",
    `${formatTaskTimestamp(options.now)}--ralph-prompt-${promptTaskSlug(options.promptText)}__inprogress`,
  );

  if (existsSync(taskDir)) {
    throw new Error(
      `Prompt task directory already exists: ${taskDir}. Retry in a second.`,
    );
  }

  mkdirSync(taskDir, { recursive: true });

  const planFilePath = join(taskDir, "plan.md");
  const progressFilePath = join(taskDir, "progress.md");

  const investigationPaths = gatherInitialInvestigationPaths(options.cwd);

  writeFileSync(
    planFilePath,
    buildPromptPlanTemplate(options.promptText, investigationPaths),
    "utf8",
  );
  writeFileSync(progressFilePath, buildPromptProgressTemplate(), "utf8");

  return {
    taskDir,
    planFilePath,
    progressFilePath,
  };
}
