import type {
  RalphPendingCollapseReason,
  RalphTargetName,
} from "./contract.js";

export interface RalphState {
  active: boolean;
  stopping: boolean;
  pausedBySteer?: boolean;
  continueRequested?: boolean;
  targetName: RalphTargetName;
  iteration: number;
  maxIterations: number;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths: string[];
}

export interface RalphPendingCollapse {
  targetId: string;
  iteration: number;
  finalReason: RalphPendingCollapseReason;
  achievedSummary: string;
}

export function buildStatusMessage(state: RalphState | null): string {
  if (!state?.active) {
    return "Ralph loop is not active.";
  }

  const attachments =
    state.attachmentPaths.length > 0
      ? `Artifacts: ${state.attachmentPaths.join(", ")}`
      : "";
  const stopping = state.stopping ? "Stop requested: yes" : "";
  const pausedBySteer = state.pausedBySteer ? "Paused by steering: yes" : "";
  const continueRequested = state.continueRequested
    ? "Continue requested: yes"
    : "";

  return [
    "Ralph loop: active",
    `Target: ${state.targetName}`,
    `Iteration: ${state.iteration}/${state.maxIterations}`,
    `Plan: ${state.planFilePath}`,
    `Progress: ${state.progressFilePath}`,
    attachments,
    stopping,
    pausedBySteer,
    continueRequested,
  ]
    .filter(Boolean)
    .join("\n");
}
