import type { RalphPendingCollapseReason, RalphRunMode } from "./contract.js";
import { hasCompleteSigil } from "./text.js";

interface RalphFinalReasonState {
  stopping: boolean;
  runMode: RalphRunMode;
  iteration: number;
  maxIterations: number;
}

export function getCollapseOutcome(
  finalReason: RalphPendingCollapseReason,
): string {
  if (finalReason === "complete") {
    return "Iteration completed the entire Ralph plan.";
  }
  if (finalReason === "stop") {
    return "Iteration finished and the Ralph loop was stopped by the user.";
  }
  if (finalReason === "max") {
    return "Iteration finished and the Ralph loop hit its max-iteration cap.";
  }
  if (finalReason === "once") {
    return "Iteration finished and single-iteration mode completed.";
  }
  return "Iteration completed; re-read the plan and progress files before continuing.";
}

export function getFinalReason(
  currentState: RalphFinalReasonState,
  assistantText: string,
): RalphPendingCollapseReason {
  if (hasCompleteSigil(assistantText)) {
    return "complete";
  }
  if (currentState.stopping) {
    return "stop";
  }
  if (currentState.runMode === "once") {
    return "once";
  }
  if (currentState.iteration >= currentState.maxIterations) {
    return "max";
  }
  return null;
}
