import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  type RalphBuiltinTarget,
  type RalphCommand,
  type RalphRunMode,
  defaultProgressPathForPlan,
  parseRalphCommand,
} from "./command.js";
import { buildIterationPrompt, buildRalphSystemPrompt } from "./prompt.js";
import { buildProgressTemplate, seedBuiltinTarget } from "./targets.js";
import { hasCompleteSigil } from "./text.js";

type RalphTargetName = RalphBuiltinTarget | "custom";
type RalphStopReason =
  | "complete"
  | "stop"
  | "manual"
  | "max"
  | "once"
  | "error";

interface PendingCollapse {
  targetId: string;
  iteration: number;
  finalReason: Exclude<RalphStopReason, "manual"> | null;
}

interface RalphState {
  active: boolean;
  stopping: boolean;
  runMode: RalphRunMode;
  iteration: number;
  maxIterations: number;
  targetName: RalphTargetName;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths: string[];
  iterationAnchorId: string | null;
  storedCommandCtx: ExtensionCommandContext | null;
  pendingCollapse: PendingCollapse | null;
}

const STATUS_KEY = "ralph-loop";
const ANCHOR_MESSAGE_TYPE = "ralph-loop-anchor";

const FINAL_REASON_MESSAGES: Record<
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

let state: RalphState | null = null;

function getAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };

    if (message?.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    return message.content
      .filter((block): block is { type: "text"; text: string } => {
        return block.type === "text" && typeof block.text === "string";
      })
      .map((block) => block.text)
      .join("\n");
  }

  return "";
}

function updateStatus(ctx: ExtensionContext | undefined): void {
  if (!ctx?.hasUI) {
    return;
  }

  if (!state?.active) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const label = `${state.targetName} · ${state.iteration}/${state.maxIterations}`;
  ctx.ui.setStatus(STATUS_KEY, `🧭 Ralph ${label}`);
}

function clearState(ctx?: ExtensionContext): void {
  state = null;
  updateStatus(ctx);
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function ensureProgressFile(
  progressFilePath: string,
  targetName: RalphTargetName,
): void {
  if (existsSync(progressFilePath)) {
    return;
  }

  ensureParentDirectory(progressFilePath);
  writeFileSync(progressFilePath, buildProgressTemplate(targetName), "utf8");
}

function ensureAnchorEntry(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): string | null {
  const leafId = ctx.sessionManager.getLeafId();
  if (leafId) {
    return leafId;
  }

  pi.sendMessage(
    {
      customType: ANCHOR_MESSAGE_TYPE,
      content: "Ralph loop anchor",
      display: false,
    },
    { triggerTurn: false },
  );

  return ctx.sessionManager.getLeafId() ?? null;
}

function finalizeLoop(ctx: ExtensionContext, reason: RalphStopReason): void {
  const lastState = state;
  clearState(ctx);

  if (!ctx.hasUI) {
    return;
  }

  const targetLabel = lastState?.targetName ?? "ralph";
  const message = FINAL_REASON_MESSAGES[reason];
  ctx.ui.notify(message.text(targetLabel), message.level);
}

function startIteration(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!state?.active) {
    return;
  }

  state.iterationAnchorId = ensureAnchorEntry(ctx, pi);
  updateStatus(ctx);
  pi.sendUserMessage(
    buildIterationPrompt({
      iteration: state.iteration,
      planFilePath: state.planFilePath,
      progressFilePath: state.progressFilePath,
      attachmentPaths: state.attachmentPaths,
    }),
  );
}

function buildStatusMessage(): string {
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

function resolveStartCommand(
  command: Extract<RalphCommand, { kind: "start" }>,
  ctx: ExtensionCommandContext,
): {
  targetName: RalphTargetName;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths: string[];
} {
  if (command.source.kind === "builtin") {
    const seeded = seedBuiltinTarget({
      cwd: ctx.cwd,
      target: command.source.target,
      now: new Date(),
    });
    return {
      targetName: command.source.target,
      planFilePath: seeded.planFilePath,
      progressFilePath: seeded.progressFilePath,
      attachmentPaths: seeded.attachmentPaths,
    };
  }

  const planFilePath = resolve(ctx.cwd, command.source.planFile);
  if (!existsSync(planFilePath)) {
    throw new Error(`Plan file does not exist: ${planFilePath}`);
  }

  const progressFilePath = resolve(
    ctx.cwd,
    command.source.progressFile ??
      defaultProgressPathForPlan(command.source.planFile),
  );
  ensureProgressFile(progressFilePath, "custom");

  return {
    targetName: "custom",
    planFilePath,
    progressFilePath,
    attachmentPaths: [],
  };
}

function getCollapseOutcome(
  finalReason: PendingCollapse["finalReason"],
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

function getFinalReason(
  currentState: RalphState,
  assistantText: string,
): PendingCollapse["finalReason"] {
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

export default function ralphLoopExtension(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => {
    if (!state?.active || event.source === "extension") {
      return;
    }

    if (event.text.trim().startsWith("/ralph")) {
      return;
    }

    finalizeLoop(ctx, "manual");
  });

  pi.on("before_agent_start", async (event) => {
    if (!state?.active) {
      return;
    }

    return {
      systemPrompt: buildRalphSystemPrompt({
        basePrompt: event.systemPrompt,
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        planFilePath: state.planFilePath,
        progressFilePath: state.progressFilePath,
      }),
    };
  });

  pi.on("session_before_tree", async (event) => {
    if (!state?.pendingCollapse) {
      return;
    }

    if (event.preparation.targetId !== state.pendingCollapse.targetId) {
      return;
    }

    return {
      summary: {
        summary: [
          "[RALPH LOOP ITERATION COLLAPSED]",
          `Iteration: ${state.pendingCollapse.iteration}`,
          `Plan: ${state.planFilePath}`,
          `Progress: ${state.progressFilePath}`,
          state.attachmentPaths.length > 0
            ? `Artifacts: ${state.attachmentPaths.join(", ")}`
            : "",
          `Outcome: ${getCollapseOutcome(state.pendingCollapse.finalReason)}`,
        ]
          .filter(Boolean)
          .join("\n"),
        details: {
          iteration: state.pendingCollapse.iteration,
          target: state.targetName,
        },
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state?.active) {
      return;
    }

    const finalReason = getFinalReason(state, getAssistantText(event.messages));

    const targetId = state.iterationAnchorId;
    const commandCtx = state.storedCommandCtx;
    if (!targetId || !commandCtx) {
      finalizeLoop(ctx, finalReason ?? "error");
      return;
    }

    state.pendingCollapse = {
      targetId,
      iteration: state.iteration,
      finalReason,
    };

    try {
      const result = await commandCtx.navigateTree(targetId, {
        summarize: true,
      });
      if (result.cancelled) {
        finalizeLoop(ctx, finalReason ?? "error");
        return;
      }
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Ralph collapse failed: ${message}`, "error");
      }
      finalizeLoop(ctx, finalReason ?? "error");
      return;
    } finally {
      if (state) {
        state.pendingCollapse = null;
      }
    }

    if (!state?.active) {
      return;
    }

    if (finalReason) {
      finalizeLoop(ctx, finalReason);
      return;
    }

    state.iteration += 1;
    startIteration(commandCtx, pi);
  });

  pi.on("session_before_compact", async () => {
    if (!state?.active) {
      return;
    }

    return { cancel: true };
  });

  pi.on("session_start", async (_event, ctx) => {
    clearState(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearState(ctx);
  });

  pi.registerCommand("ralph", {
    description: "Run a Ralph planning loop",
    handler: async (args, ctx) => {
      let command: RalphCommand;
      try {
        command = parseRalphCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid /ralph command: ${message}`, "error");
        return;
      }

      if (command.kind === "status") {
        ctx.ui.notify(buildStatusMessage(), "info");
        updateStatus(ctx);
        return;
      }

      if (command.kind === "stop") {
        if (!state?.active) {
          ctx.ui.notify("Ralph loop is not active.", "info");
          return;
        }

        if (ctx.isIdle()) {
          finalizeLoop(ctx, "stop");
          return;
        }

        state.stopping = true;
        ctx.ui.notify(
          "Ralph loop will stop after the current iteration completes.",
          "info",
        );
        updateStatus(ctx);
        return;
      }

      if (state?.active) {
        ctx.ui.notify(
          "Ralph loop already active. Use `/ralph stop` first.",
          "error",
        );
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is busy. Wait for the current turn to finish before starting Ralph.",
          "error",
        );
        return;
      }

      try {
        const resolved = resolveStartCommand(command, ctx);
        const effectiveMaxIterations =
          command.runMode === "once" ? 1 : command.maxIterations;

        state = {
          active: true,
          stopping: false,
          runMode: command.runMode,
          iteration: 1,
          maxIterations: effectiveMaxIterations,
          targetName: resolved.targetName,
          planFilePath: resolved.planFilePath,
          progressFilePath: resolved.progressFilePath,
          attachmentPaths: resolved.attachmentPaths,
          iterationAnchorId: null,
          storedCommandCtx: ctx,
          pendingCollapse: null,
        };
        updateStatus(ctx);
        ctx.ui.notify(buildStatusMessage(), "info");
        startIteration(ctx, pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        clearState(ctx);
        ctx.ui.notify(`Failed to start Ralph loop: ${message}`, "error");
      }
    },
  });
}
