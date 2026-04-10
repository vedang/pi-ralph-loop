export interface RalphIterationPromptOptions {
  iteration: number;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths?: string[];
}

export function buildIterationPrompt(
  options: RalphIterationPromptOptions,
): string {
  const attachmentLines = [
    `@${options.planFilePath}`,
    `@${options.progressFilePath}`,
    ...(options.attachmentPaths ?? []).map((path) => `@${path}`),
  ];

  return [
    ...attachmentLines,
    "",
    `You are in Ralph Loop iteration ${options.iteration}.`,
    "",
    "1. Read the attached planning artifacts.",
    "2. Choose the single highest-priority incomplete task.",
    "3. Complete only that one task this iteration.",
    "4. Run relevant feedback loops (for example, `make test`, `make check`, `make format`) before you finish this task.",
    "5. Do not consider the task complete while relevant feedback loops are failing.",
    "6. Make a git commit for this iteration.",
    "7. Update the progress file concisely before you finish.",
    "8. If all tasks are complete, output <COMPLETE> on a line by itself.",
    "",
    "ONLY WORK ON A SINGLE TASK PER ITERATION.",
  ].join("\n");
}
