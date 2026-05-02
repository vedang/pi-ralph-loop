import { relative } from "node:path";

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
  RALPH_PROMPT_TARGET,
  RALPH_STATUS_KEY,
  type RalphRunMode,
  type RalphStopReason,
} from "./contract.js";
import { getCollapseOutcome, getFinalReason } from "./loop-policy.js";
import {
  type SeedPromptTargetResult,
  seedPromptTarget,
} from "./prompt-target.js";
import { buildIterationPrompt, buildRalphSystemPrompt } from "./prompt.js";
import {
  type ResolvedRalphStart,
  resolveStartCommand,
} from "./runtime-start.js";
import {
  type RalphPendingCollapse,
  type RalphState,
  buildStatusMessage,
} from "./runtime-state.js";
import { stripStandaloneCompleteSigil } from "./text.js";

interface RalphStateV2 extends RalphState {
  runId: number;
  runMode: RalphRunMode;
  iterationAnchorId: string | null;
  storedCommandCtx: ExtensionCommandContext | null;
  pendingCollapse: RalphPendingCollapse | null;
  scheduledIteration: number | null;
}

const RALPH_BUSY_ERROR =
  "Agent is busy. Wait for the current turn to finish before starting Ralph.";

let nextRunId = 0;
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

function notifyIfBusy(ctx: ExtensionCommandContext): boolean {
  if (ctx.isIdle()) {
    return false;
  }

  ctx.ui.notify(RALPH_BUSY_ERROR, "error");
  return true;
}

function isPromptSynthesisLoop(): boolean {
  return state?.targetName === RALPH_PROMPT_TARGET;
}

function ensureCanStartLoop(ctx: ExtensionCommandContext): boolean {
  if (state?.active) {
    ctx.ui.notify(
      "Ralph loop already active. Use `/ralph stop` first.",
      "error",
    );
    return false;
  }

  return !notifyIfBusy(ctx);
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
      promptSynthesis: isPromptSynthesisLoop(),
    }),
  );
}

function isCurrentScheduledState(
  scheduledState: RalphStateV2 | null,
  runId: number,
  scheduledIteration: number,
): scheduledState is RalphStateV2 {
  return Boolean(
    scheduledState?.active &&
      state === scheduledState &&
      scheduledState.runId === runId &&
      scheduledState.scheduledIteration === scheduledIteration &&
      scheduledState.iteration === scheduledIteration - 1,
  );
}

async function getScheduledIdleState(
  ctx: ExtensionCommandContext,
  runId: number,
  scheduledIteration: number,
): Promise<RalphStateV2 | null> {
  while (true) {
    const scheduledState = state;
    if (!isCurrentScheduledState(scheduledState, runId, scheduledIteration)) {
      return null;
    }

    if (ctx.isIdle()) {
      return scheduledState;
    }

    await ctx.waitForIdle();
  }
}

function clearScheduledIteration(
  runId: number,
  scheduledIteration: number,
): boolean {
  const scheduledState = state;
  if (
    !scheduledState?.active ||
    scheduledState.runId !== runId ||
    scheduledState.scheduledIteration !== scheduledIteration
  ) {
    return false;
  }

  scheduledState.scheduledIteration = null;
  return true;
}

async function runScheduledIteration(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  runId: number,
  scheduledIteration: number,
): Promise<void> {
  try {
    const scheduledState = await getScheduledIdleState(
      ctx,
      runId,
      scheduledIteration,
    );
    if (!isCurrentScheduledState(scheduledState, runId, scheduledIteration)) {
      return;
    }

    if (scheduledState.stopping) {
      finalizeLoop(ctx, "stop");
      return;
    }

    scheduledState.iteration = scheduledIteration;
    startIteration(ctx, pi);
    clearScheduledIteration(runId, scheduledIteration);
  } catch (error) {
    if (!clearScheduledIteration(runId, scheduledIteration)) {
      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Ralph delayed iteration failed: ${formatError(error)}`,
        "error",
      );
    }
    finalizeLoop(ctx, "error");
  }
}

function scheduleNextIteration(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  scheduledIteration: number,
): void {
  if (!state?.active) {
    return;
  }

  if (state.scheduledIteration === scheduledIteration) {
    return;
  }

  const runId = state.runId;
  state.scheduledIteration = scheduledIteration;

  setTimeout(() => {
    void runScheduledIteration(ctx, pi, runId, scheduledIteration);
  }, 0);
}

function startRalphLoop(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  resolved: ResolvedRalphStart,
  runMode: RalphRunMode,
  maxIterations: number,
): void {
  nextRunId += 1;
  state = {
    active: true,
    stopping: false,
    runId: nextRunId,
    runMode,
    iteration: 1,
    maxIterations,
    targetName: resolved.targetName,
    planFilePath: resolved.planFilePath,
    progressFilePath: resolved.progressFilePath,
    attachmentPaths: resolved.attachmentPaths,
    iterationAnchorId: null,
    storedCommandCtx: ctx,
    pendingCollapse: null,
    scheduledIteration: null,
  };
  updateStatus(ctx);
  ctx.ui.notify(buildStatusMessage(state), "info");
  startIteration(ctx, pi);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handlePromptCommand(
  ctx: ExtensionCommandContext,
  promptText: string,
): SeedPromptTargetResult {
  const normalizedPrompt = promptText.trim();
  if (!normalizedPrompt) {
    throw new Error("Prompt requires user prompt text after `/ralph-prompt`");
  }

  return seedPromptTarget({
    cwd: ctx.cwd,
    promptText: normalizedPrompt,
    now: new Date(),
  });
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
        promptSynthesis: isPromptSynthesisLoop(),
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
          state.pendingCollapse.achievedSummary
            ? `Achieved: ${state.pendingCollapse.achievedSummary}`
            : "",
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
    const finalReasonOrError = finalReason ?? "error";
    const achievedSummary = stripStandaloneCompleteSigil(assistantText);

    const targetId = state.iterationAnchorId;
    const commandCtx = state.storedCommandCtx;
    if (!targetId || !commandCtx) {
      finalizeLoop(ctx, finalReasonOrError);
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
        finalizeLoop(ctx, finalReasonOrError);
        return;
      }
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Ralph collapse failed: ${message}`, "error");
      }
      finalizeLoop(ctx, finalReasonOrError);
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

    scheduleNextIteration(commandCtx, pi, state.iteration + 1);
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
        ctx.ui.notify(`Invalid /ralph command: ${formatError(error)}`, "error");
        return;
      }

      switch (command.kind) {
        case "help":
          showRalphHelp(ctx);
          return;

        case "status":
          ctx.ui.notify(buildStatusMessage(state), "info");
          updateStatus(ctx);
          return;

        case "stop": {
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

        case "start":
          break;
      }

      if (!ensureCanStartLoop(ctx)) {
        return;
      }

      try {
        const resolved = resolveStartCommand(command, ctx);
        const effectiveMaxIterations =
          command.runMode === "once" ? 1 : command.maxIterations;

        startRalphLoop(
          ctx,
          pi,
          resolved,
          command.runMode,
          effectiveMaxIterations,
        );
      } catch (error) {
        clearState(ctx);
        ctx.ui.notify(
          `Failed to start Ralph loop: ${formatError(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("ralph-prompt", {
    description: "Create a Ralph prompt plan",
    handler: async (args, ctx) => {
      if (!ensureCanStartLoop(ctx)) {
        return;
      }

      try {
        const seeded = handlePromptCommand(ctx, args);
        const planPath = relative(ctx.cwd, seeded.planFilePath);
        const progressPath = relative(ctx.cwd, seeded.progressFilePath);

        ctx.ui.notify(
          [
            `Created Ralph prompt plan: ${planPath}`,
            `Progress: ${progressPath}`,
            `After this synthesis pass, run: \`/ralph ${planPath}\``,
          ].join("\n"),
          "info",
        );

        startRalphLoop(
          ctx,
          pi,
          {
            targetName: RALPH_PROMPT_TARGET,
            planFilePath: seeded.planFilePath,
            progressFilePath: seeded.progressFilePath,
            attachmentPaths: [],
          },
          "once",
          1,
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to create prompt plan: ${formatError(error)}`,
          "error",
        );
      }
    },
  });
}
