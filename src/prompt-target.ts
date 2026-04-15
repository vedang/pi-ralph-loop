import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { SHARED_RULE_LINES, formatTaskTimestamp } from "./targets.js";

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

function promptTaskSlug(promptText: string): string {
  const [primary = "prompt", secondary = "plan"] =
    promptText.toLowerCase().match(/[a-z0-9]+/g) ?? [];

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
      (promptText.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => {
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
    "Turn the user prompt into completed repository work, using this plan and `progress.md` as the durable loop state.",
    "",
    "## User Prompt",
    normalizedPrompt || "(missing prompt text)",
    "",
    "## Initial Investigation",
    "- Workspace scan used only local filesystem data.",
    "- Likely relevant files from prompt keywords:",
    ...toIndentedBulletLines(relevantPaths),
    "- Additional project markers discovered:",
    ...toIndentedBulletLines(rootMarkers),
    "",
    "## Suggested Workflow",
    "- Start by reading the likely relevant files above and refining scope in `progress.md`.",
    "- Convert the prompt into concrete acceptance criteria before making changes.",
    "- If behavior changes or bugs are involved, add or update tests before implementation.",
    "- Make the smallest code or docs changes that satisfy the prompt.",
    "- Run `make test`, `make check`, and `make format` before marking work complete.",
    "",
    "## Ralph Loop Rules",
    ...SHARED_RULE_LINES,
    "",
    "## Completion Criteria",
    "- The user prompt is satisfied in this repository.",
    "- Relevant automated checks pass.",
    "- `progress.md` records the important decisions and completed work.",
    "- Output `<COMPLETE>` on a line by itself when everything is done.",
    "",
  ].join("\n");
}

function buildPromptProgressTemplate(promptText: string): string {
  return [
    "# Progress: Ralph prompt",
    "",
    "## Status",
    "in progress",
    "",
    "## Iterations",
    `- Seeded prompt-plan artifacts from user prompt: ${promptText.trim() || "(missing prompt text)"}`,
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
  writeFileSync(
    progressFilePath,
    buildPromptProgressTemplate(options.promptText),
    "utf8",
  );

  return {
    taskDir,
    planFilePath,
    progressFilePath,
  };
}
