import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type RalphBuiltinTarget = "unit-tests" | "clean-room";

export interface SeededBuiltinTarget {
  taskDir: string;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths: string[];
}

export interface SeedBuiltinTargetOptions {
  cwd: string;
  target: RalphBuiltinTarget;
  now: Date;
}

const TARGET_SLUGS: Record<RalphBuiltinTarget, string> = {
  "unit-tests": "ralph-unit-tests-coverage",
  "clean-room": "ralph-clean-room-spec",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTaskTimestamp(date: Date): string {
  return [
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`,
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`,
  ].join("T");
}

function progressTemplate(target: RalphBuiltinTarget): string {
  return [
    `# Progress: Ralph ${target}`,
    "",
    "## Status",
    "in progress",
    "",
    "## Iterations",
    "- Initialized Ralph loop artifacts.",
    "",
  ].join("\n");
}

function unitTestsPlanTemplate(): string {
  return [
    "# Plan: Ralph unit-tests",
    "",
    "## Goal",
    "Ensure this repository has all necessary automated tests for the important behaviors you can identify.",
    "",
    "## Ralph Loop Rules",
    "- ONLY WORK ON A SINGLE TASK PER ITERATION.",
    "- Pick the single highest-priority missing or weak test area.",
    "- Add or improve tests first.",
    "- Keep production code changes minimal and only make them when required to enable testing.",
    "- Run the repository feedback loop (`make test`, `make check`, `make format`) when relevant and available.",
    "- Update `progress.md` concisely after each iteration.",
    "",
    "## Completion Criteria",
    "- All necessary automated tests that you can reasonably identify are present.",
    "- The test suite is healthy.",
    "- No higher-priority missing coverage area remains.",
    "- When complete, output `<COMPLETE>` on a line by itself.",
    "",
  ].join("\n");
}

function cleanRoomPlanTemplate(): string {
  return [
    "# Plan: Ralph clean-room",
    "",
    "## Goal",
    "Create and refine `spec.md` until it is sufficient for an independent clean-room reimplementation of this repository in another programming language.",
    "",
    "## Ralph Loop Rules",
    "- ONLY WORK ON A SINGLE TASK PER ITERATION.",
    "- Read the repository source and improve only one high-value section of the spec each iteration.",
    "- Use `spec.md` as the persistent clean-room artifact.",
    "- Capture behavior, interfaces, data structures, workflows, constraints, error handling, and test expectations.",
    "- Avoid copying implementation code verbatim into the specification.",
    "- Update `progress.md` concisely after each iteration.",
    "",
    "## Completion Criteria",
    "- `spec.md` is coherent, complete, and implementation-oriented.",
    "- Another engineer could use `spec.md` to produce a clean-room reimplementation without depending on the original source code.",
    "- When complete, output `<COMPLETE>` on a line by itself.",
    "",
  ].join("\n");
}

function cleanRoomSpecTemplate(): string {
  return [
    "# Clean-room Specification",
    "",
    "## Overview",
    "- Purpose:",
    "- Audience:",
    "- Reimplementation target language:",
    "",
    "## External behavior",
    "-",
    "",
    "## Data model and state",
    "-",
    "",
    "## Workflows and algorithms",
    "-",
    "",
    "## Error handling and edge cases",
    "-",
    "",
    "## Test and validation expectations",
    "-",
    "",
  ].join("\n");
}

export function seedBuiltinTarget(
  options: SeedBuiltinTargetOptions,
): SeededBuiltinTarget {
  const taskDir = resolve(
    options.cwd,
    ".agents",
    "plans",
    `${formatTaskTimestamp(options.now)}--${TARGET_SLUGS[options.target]}__inprogress`,
  );

  if (existsSync(taskDir)) {
    throw new Error(
      `Built-in Ralph task directory already exists: ${taskDir}. Retry in a second.`,
    );
  }

  mkdirSync(taskDir, { recursive: true });

  const planFilePath = join(taskDir, "plan.md");
  const progressFilePath = join(taskDir, "progress.md");
  const attachmentPaths: string[] = [];

  writeFileSync(progressFilePath, progressTemplate(options.target), "utf8");

  if (options.target === "unit-tests") {
    writeFileSync(planFilePath, unitTestsPlanTemplate(), "utf8");
    return { taskDir, planFilePath, progressFilePath, attachmentPaths };
  }

  const specFilePath = join(taskDir, "spec.md");
  writeFileSync(planFilePath, cleanRoomPlanTemplate(), "utf8");
  writeFileSync(specFilePath, cleanRoomSpecTemplate(), "utf8");
  attachmentPaths.push(specFilePath);

  return {
    taskDir,
    planFilePath,
    progressFilePath,
    attachmentPaths,
  };
}
