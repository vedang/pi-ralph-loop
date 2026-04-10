import type {
  RalphPendingCollapseReason,
  RalphTargetName,
} from "./contract.js";

export interface RalphState {
  active: boolean;
  stopping: boolean;
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

  return [
    "Ralph loop: active",
    `Target: ${state.targetName}`,
    `Iteration: ${state.iteration}/${state.maxIterations}`,
    `Plan: ${state.planFilePath}`,
    `Progress: ${state.progressFilePath}`,
    attachments,
    stopping,
  ]
    .filter(Boolean)
    .join("\n");
}
