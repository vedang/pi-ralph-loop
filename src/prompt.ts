import { RALPH_SINGLE_TASK_RULE } from "./contract.js";

export interface RalphIterationPromptOptions {
  iteration: number;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths?: string[];
  promptSynthesis?: boolean;
}

export interface RalphSystemPromptOptions {
  basePrompt: string;
  iteration: number;
  maxIterations: number;
  planFilePath: string;
  progressFilePath: string;
  promptSynthesis?: boolean;
}

const PROMPT_VARIANTS = {
  default: {
    instructions: [
      "1. Read the attached planning artifacts.",
      "2. Choose the single highest-priority incomplete task.",
      "3. Complete only that one task this iteration.",
      "4. Run relevant feedback loops (for example, `make test`, `make check`, `make format`) before you finish this task.",
      "5. Do not consider the task complete while relevant feedback loops are failing.",
      "6. Make a git commit for this iteration.",
      "7. Update the progress file concisely before you finish.",
      "8. If all tasks are complete, output <COMPLETE> on a line by itself.",
    ],
    systemPromptReminder:
      "Read the attached artifacts each iteration, work on exactly one task, run relevant feedback loops before finishing, make a git commit for the iteration, and use <COMPLETE> on a line by itself when everything is done.",
  },
  synthesis: {
    instructions: [
      "1. Read the attached planning artifacts and original user prompt.",
      "2. Investigate this repository and any user-referenced local paths as needed to understand the request.",
      "3. Rewrite `plan.md` into detailed, self-contained Ralph execution plan for later `/ralph <plan.md>` use.",
      "4. Preserve user constraints, requested tools, and workflow expectations in the rewritten plan.",
      "5. Do not implement underlying repository task yet.",
      "6. Keep `progress.md` minimal.",
      "7. Summarize what the rewritten plan now covers and any important open questions.",
    ],
    systemPromptReminder:
      "Read the attached artifacts, perform one prompt-synthesis pass, rewrite `plan.md` into a self-contained plan for later `/ralph <plan.md>` execution, keep `progress.md` minimal, and do not implement the underlying repository task yet.",
  },
} as const;

export const SINGLE_TASK_RULE = RALPH_SINGLE_TASK_RULE;

function buildAttachmentLines(options: RalphIterationPromptOptions): string[] {
  return [
    `@${options.planFilePath}`,
    `@${options.progressFilePath}`,
    ...(options.attachmentPaths ?? []).map((path) => `@${path}`),
  ];
}

function getPromptVariant(promptSynthesis = false) {
  return promptSynthesis ? PROMPT_VARIANTS.synthesis : PROMPT_VARIANTS.default;
}

export function buildIterationPrompt(
  options: RalphIterationPromptOptions,
): string {
  const variant = getPromptVariant(options.promptSynthesis);

  return [
    ...buildAttachmentLines(options),
    "",
    `You are in Ralph Loop iteration ${options.iteration}.`,
    "",
    ...variant.instructions,
    "",
    SINGLE_TASK_RULE,
  ].join("\n");
}

export function buildRalphSystemPrompt(
  options: RalphSystemPromptOptions,
): string {
  const variant = getPromptVariant(options.promptSynthesis);

  return `${options.basePrompt}

RALPH LOOP ACTIVE
Iteration: ${options.iteration}/${options.maxIterations}
Plan file: ${options.planFilePath}
Progress file: ${options.progressFilePath}
${variant.systemPromptReminder}`;
}
