export type RalphBuiltinTarget = "unit-tests" | "clean-room";

export const RALPH_CUSTOM_TARGET = "custom" as const;
export const RALPH_PROMPT_TARGET = "prompt" as const;

export type RalphTargetName =
  | RalphBuiltinTarget
  | typeof RALPH_CUSTOM_TARGET
  | typeof RALPH_PROMPT_TARGET;

export type RalphRunMode = "loop" | "once";
export type RalphStopReason =
  | "complete"
  | "stop"
  | "manual"
  | "max"
  | "once"
  | "error";

export type RalphPendingCollapseReason = Exclude<
  RalphStopReason,
  "manual"
> | null;

export const RALPH_STATUS_KEY = "ralph-loop" as const;
export const RALPH_ANCHOR_MESSAGE_TYPE = "ralph-loop-anchor" as const;

export const RALPH_SINGLE_TASK_RULE =
  "ONLY WORK ON A SINGLE TASK PER ITERATION.";

export const RALPH_FINAL_REASON_MESSAGES: Record<
  RalphStopReason,
  { level: "info" | "warning" | "error"; text: (targetLabel: string) => string }
> = {
  complete: {
    level: "info",
    text: (targetLabel) => `Ralph loop complete for ${targetLabel}.`,
  },
  stop: {
    level: "info",
    text: (targetLabel) => `Ralph loop stopped for ${targetLabel}.`,
  },
  manual: {
    level: "warning",
    text: (targetLabel) =>
      `Ralph loop stopped by manual input for ${targetLabel}.`,
  },
  max: {
    level: "warning",
    text: (targetLabel) =>
      `Ralph loop hit the max-iteration cap for ${targetLabel}.`,
  },
  once: {
    level: "info",
    text: (targetLabel) =>
      `Ralph loop completed the single requested iteration for ${targetLabel}.`,
  },
  error: {
    level: "error",
    text: (targetLabel) =>
      `Ralph loop stopped due to an error for ${targetLabel}.`,
  },
};
