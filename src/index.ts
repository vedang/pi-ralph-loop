import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  RALPH_HELP_TEXT,
  type RalphCommand,
  parseRalphCommand,
} from "./command.js";
import {
  RALPH_ANCHOR_MESSAGE_TYPE,
  RALPH_FINAL_REASON_MESSAGES,
  RALPH_STATUS_KEY,
  type RalphRunMode,
  type RalphStopReason,
} from "./contract.js";
import { getCollapseOutcome, getFinalReason } from "./loop-policy.js";
import { buildIterationPrompt, buildRalphSystemPrompt } from "./prompt.js";
import { resolveStartCommand } from "./runtime-start.js";
import {
  type RalphPendingCollapse,
  type RalphState,
  buildStatusMessage,
} from "./runtime-state.js";
import { summarizeIterationAchievement } from "./text.js";

interface RalphStateV2 extends RalphState {
  runMode: RalphRunMode;
  iterationAnchorId: string | null;
  storedCommandCtx: ExtensionCommandContext | null;
  pendingCollapse: RalphPendingCollapse | null;
}

let state: RalphStateV2 | null = null;

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
    ctx.ui.setStatus(RALPH_STATUS_KEY, undefined);
    return;
  }

  const label = `${state.targetName} · ${state.iteration}/${state.maxIterations}`;
  ctx.ui.setStatus(RALPH_STATUS_KEY, `🧭 Ralph ${label}`);
}

function clearState(ctx?: ExtensionContext): void {
  state = null;
  updateStatus(ctx);
}

function showRalphHelp(ctx: ExtensionContext): void {
  ctx.ui.notify(RALPH_HELP_TEXT, "info");
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
      customType: RALPH_ANCHOR_MESSAGE_TYPE,
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
  const message = RALPH_FINAL_REASON_MESSAGES[reason];
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
          state.pendingCollapse.achievedSummary
            ? `Achieved: ${state.pendingCollapse.achievedSummary}`
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

    const assistantText = getAssistantText(event.messages);
    const finalReason = getFinalReason(state, assistantText);
    const achievedSummary = summarizeIterationAchievement(assistantText);

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
      achievedSummary,
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

      if (command.kind === "help") {
        showRalphHelp(ctx);
        return;
      }

      if (command.kind === "status") {
        ctx.ui.notify(buildStatusMessage(state), "info");
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
        ctx.ui.notify(buildStatusMessage(state), "info");
        startIteration(ctx, pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        clearState(ctx);
        ctx.ui.notify(`Failed to start Ralph loop: ${message}`, "error");
      }
    },
  });
}
