import { relative } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
  type RalphPendingCollapseReason,
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
  storedCommandCtx: ExtensionCommandContext;
  pendingCollapse: RalphPendingCollapse | null;
  scheduledIteration: number | null;
  pendingIterationPrompt: string | null;
  activeOwnedIteration: number | null;
  pausedBySteer: boolean;
  continueRequested: boolean;
  pendingOwnedCompletion: OwnedIterationCompletion | null;
}
const RALPH_BUSY_ERROR =
  "Agent is busy. Wait for the current turn to finish before starting Ralph.";
const FOLLOW_UP_DRAIN_POLL_MS = 25;

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

function getStreamingBehavior(
  event: unknown,
): "steer" | "followUp" | undefined {
  const value = (event as { streamingBehavior?: unknown }).streamingBehavior;
  return value === "steer" || value === "followUp" ? value : undefined;
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
  const iterationPrompt = buildIterationPrompt({
    iteration: state.iteration,
    planFilePath: state.planFilePath,
    progressFilePath: state.progressFilePath,
    attachmentPaths: state.attachmentPaths,
    promptSynthesis: isPromptSynthesisLoop(),
  });

  state.pendingIterationPrompt = iterationPrompt;
  state.activeOwnedIteration = null;
  updateStatus(ctx);
  pi.sendUserMessage(iterationPrompt);
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

interface OwnedIterationCompletion {
  runId: number;
  iteration: number;
  targetId: string;
  finalReason: RalphPendingCollapseReason;
  achievedSummary: string;
}

function isCurrentTurnState(
  candidateState: RalphStateV2 | null,
  runId: number,
  iteration: number,
): candidateState is RalphStateV2 {
  return Boolean(
    candidateState?.active &&
      candidateState.runId === runId &&
      candidateState.iteration === iteration,
  );
}

function sleep(ms = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForOwnedTurnDrain(
  ctx: ExtensionCommandContext,
  runId: number,
  iteration: number,
): Promise<boolean> {
  await sleep();

  while (true) {
    if (!isCurrentTurnState(state, runId, iteration)) {
      return false;
    }

    if (!ctx.isIdle()) {
      await ctx.waitForIdle();
      await sleep();
      continue;
    }

    if (ctx.hasPendingMessages()) {
      await sleep(FOLLOW_UP_DRAIN_POLL_MS);
      continue;
    }

    return true;
  }
}

async function handleOwnedIterationEnd(
  completion: OwnedIterationCompletion,
  commandCtx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const isReady = await waitForOwnedTurnDrain(
    commandCtx,
    completion.runId,
    completion.iteration,
  );
  if (!isReady) {
    return;
  }

  if (!isCurrentTurnState(state, completion.runId, completion.iteration)) {
    return;
  }

  const fallbackReason = completion.finalReason ?? "error";

  if (!state.iterationAnchorId) {
    finalizeLoop(commandCtx, fallbackReason);
    return;
  }

  state.pendingCollapse = {
    targetId: completion.targetId,
    iteration: completion.iteration,
    finalReason: completion.finalReason,
    achievedSummary: completion.achievedSummary,
  };

  try {
    const result = await commandCtx.navigateTree(completion.targetId, {
      summarize: true,
    });
    if (result.cancelled) {
      finalizeLoop(commandCtx, fallbackReason);
      return;
    }
  } catch (error) {
    if (commandCtx.hasUI) {
      const message = error instanceof Error ? error.message : String(error);
      commandCtx.ui.notify(`Ralph collapse failed: ${message}`, "error");
    }
    finalizeLoop(commandCtx, fallbackReason);
    return;
  } finally {
    if (
      isCurrentTurnState(state, completion.runId, completion.iteration) &&
      state.pendingCollapse?.targetId === completion.targetId &&
      state.pendingCollapse.iteration === completion.iteration
    ) {
      state.pendingCollapse = null;
    }
  }

  if (!isCurrentTurnState(state, completion.runId, completion.iteration)) {
    return;
  }

  if (completion.finalReason) {
    finalizeLoop(commandCtx, completion.finalReason);
    return;
  }

  scheduleNextIteration(commandCtx, pi, completion.iteration + 1);
}

async function resumeOwnedIteration(
  completion: OwnedIterationCompletion,
  commandCtx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const currentState = state;
  if (
    !isCurrentTurnState(currentState, completion.runId, completion.iteration)
  ) {
    return;
  }

  currentState.pausedBySteer = false;
  currentState.continueRequested = false;
  currentState.pendingOwnedCompletion = null;
  updateStatus(commandCtx);

  await handleOwnedIterationEnd(completion, commandCtx, pi);
}

function scheduleOwnedIterationCompletion(
  completion: OwnedIterationCompletion,
  commandCtx: ExtensionCommandContext,
  pi: ExtensionAPI,
  resumePausedState = false,
): void {
  setTimeout(() => {
    const completionTask = resumePausedState
      ? resumeOwnedIteration(completion, commandCtx, pi)
      : handleOwnedIterationEnd(completion, commandCtx, pi);

    void completionTask.catch((error: unknown) => {
      if (!isCurrentTurnState(state, completion.runId, completion.iteration)) {
        return;
      }

      if (commandCtx.hasUI) {
        commandCtx.ui.notify(
          `Ralph delayed completion failed: ${formatError(error)}`,
          "error",
        );
      }
      finalizeLoop(commandCtx, "error");
    });
  }, 0);
}

function storePausedCompletion(
  completion: OwnedIterationCompletion,
  commandCtx: ExtensionCommandContext,
): void {
  if (!isCurrentTurnState(state, completion.runId, completion.iteration)) {
    return;
  }

  state.pendingOwnedCompletion = completion;
  if (commandCtx.hasUI) {
    commandCtx.ui.notify(
      "Ralph loop paused. Run /ralph continue to resume.",
      "info",
    );
  }
  updateStatus(commandCtx);
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
    pendingIterationPrompt: null,
    activeOwnedIteration: null,
    pausedBySteer: false,
    continueRequested: false,
    pendingOwnedCompletion: null,
  };
  updateStatus(ctx);
  ctx.ui.notify(buildStatusMessage(state), "info");
  startIteration(ctx, pi);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleContinueCommand(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!state?.active) {
    ctx.ui.notify("Ralph loop is not active.", "info");
    return;
  }

  if (!state.pausedBySteer) {
    ctx.ui.notify("Ralph loop is not paused.", "info");
    return;
  }

  state.continueRequested = true;
  updateStatus(ctx);

  const completion = state.pendingOwnedCompletion;
  if (completion) {
    if (ctx.isIdle()) {
      ctx.ui.notify("Ralph loop continuing after steering.", "info");
      await resumeOwnedIteration(completion, ctx, pi);
      return;
    }

    ctx.ui.notify(
      "Ralph loop will continue after the steered turn completes.",
      "info",
    );
    scheduleOwnedIterationCompletion(completion, ctx, pi, true);
    return;
  }

  ctx.ui.notify(
    ctx.isIdle()
      ? "Ralph loop will continue when the steered turn completes."
      : "Ralph loop will continue after the steered turn completes.",
    "info",
  );
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
    if (event.source !== "interactive" || !state?.active) {
      return;
    }

    if (event.text.trim().startsWith("/ralph")) {
      return;
    }

    if (getStreamingBehavior(event) === "steer") {
      const wasPaused = state.pausedBySteer;
      state.pausedBySteer = true;
      if (!wasPaused && ctx.hasUI) {
        ctx.ui.notify(
          "Ralph loop paused by steering. Run /ralph continue to resume.",
          "info",
        );
      }
      updateStatus(ctx);
      return;
    }

    finalizeLoop(ctx, "manual");
  });

  pi.on("before_agent_start", async (event) => {
    if (!state?.active) {
      return;
    }

    // Only the exact prompt emitted by `startIteration()` owns Ralph state.
    if (event.prompt !== state.pendingIterationPrompt) {
      return;
    }

    state.pendingIterationPrompt = null;
    state.activeOwnedIteration = state.iteration;

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

  pi.on("agent_end", async (event) => {
    if (!state?.active || state.activeOwnedIteration !== state.iteration) {
      return;
    }

    const assistantText = getAssistantText(event.messages);
    const finalReason = getFinalReason(state, assistantText);
    const achievedSummary = stripStandaloneCompleteSigil(assistantText);
    const currentIteration = state.iteration;
    const runId = state.runId;
    const targetId = state.iterationAnchorId;
    const commandCtx = state.storedCommandCtx;
    state.activeOwnedIteration = null;

    if (!targetId) {
      finalizeLoop(commandCtx, finalReason ?? "error");
      return;
    }

    const completion = {
      runId,
      iteration: currentIteration,
      targetId,
      finalReason,
      achievedSummary,
    };

    if (state.pausedBySteer && !state.continueRequested) {
      storePausedCompletion(completion, commandCtx);
      return;
    }

    // Let later `agent_end` handlers enqueue/start extension follow-ups first.
    scheduleOwnedIterationCompletion(
      completion,
      commandCtx,
      pi,
      state.pausedBySteer && state.continueRequested,
    );
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

        case "continue":
          await handleContinueCommand(ctx, pi);
          return;

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
