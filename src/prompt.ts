export interface RalphIterationPromptOptions {
  iteration: number;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths?: string[];
}

export interface RalphSystemPromptOptions {
  basePrompt: string;
  iteration: number;
  maxIterations: number;
  planFilePath: string;
  progressFilePath: string;
}

const ITERATION_INSTRUCTIONS = [
  "1. Read the attached planning artifacts.",
  "2. Choose the single highest-priority incomplete task.",
  "3. Complete only that one task this iteration.",
  "4. Run relevant feedback loops (for example, `make test`, `make check`, `make format`) before you finish this task.",
  "5. Do not consider the task complete while relevant feedback loops are failing.",
  "6. Make a git commit for this iteration.",
  "7. Update the progress file concisely before you finish.",
  "8. If all tasks are complete, output <COMPLETE> on a line by itself.",
] as const;

const SYSTEM_PROMPT_REMINDER =
  "Read the attached artifacts each iteration, work on exactly one task, run relevant feedback loops before finishing, make a git commit for the iteration, and use <COMPLETE> on a line by itself when everything is done.";

export const SINGLE_TASK_RULE = "ONLY WORK ON A SINGLE TASK PER ITERATION.";

function buildAttachmentLines(options: RalphIterationPromptOptions): string[] {
  return [
    `@${options.planFilePath}`,
    `@${options.progressFilePath}`,
    ...(options.attachmentPaths ?? []).map((path) => `@${path}`),
  ];
}

export function buildIterationPrompt(
  options: RalphIterationPromptOptions,
): string {
  return [
    ...buildAttachmentLines(options),
    "",
    `You are in Ralph Loop iteration ${options.iteration}.`,
    "",
    ...ITERATION_INSTRUCTIONS,
    "",
    SINGLE_TASK_RULE,
  ].join("\n");
}

export function buildRalphSystemPrompt(
  options: RalphSystemPromptOptions,
): string {
  return `${options.basePrompt}

RALPH LOOP ACTIVE
Iteration: ${options.iteration}/${options.maxIterations}
Plan file: ${options.planFilePath}
Progress file: ${options.progressFilePath}
${SYSTEM_PROMPT_REMINDER}`;
}
