import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  InputSource,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import ralphLoopExtension from "../src/index";

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type UserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type ExtensionHandler = (...args: unknown[]) => Promise<unknown> | unknown;
type StreamingBehavior = "steer" | "followUp";

type Harness = ReturnType<typeof createHarness>;

function createHarness(cwd = process.cwd()): {
  commands: Map<string, RegisteredCommand["handler"]>;
  notifications: Array<{ message: string; level: string }>;
  sentUserMessages: UserMessageContent[];
  treeSummaries: string[];
  handlers: Map<string, ExtensionHandler>;
  ctx: ExtensionCommandContext;
  setIdle: (nextIdle: boolean) => void;
  setPendingMessages: (nextPendingMessages: boolean) => void;
} {
  const commands = new Map<string, RegisteredCommand["handler"]>();
  const sentUserMessages: UserMessageContent[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const treeSummaries: string[] = [];
  const handlers = new Map<string, ExtensionHandler>();
  const idleWaiters: Array<() => void> = [];
  let idle = true;
  let pendingMessages = false;

  const setIdle = (nextIdle: boolean): void => {
    idle = nextIdle;
    if (!idle) {
      return;
    }

    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  };

  const setPendingMessages = (nextPendingMessages: boolean): void => {
    pendingMessages = nextPendingMessages;
  };

  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: {
      getLeafId: () => "leaf-1",
    },
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
    },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    waitForIdle: async () => {
      if (idle) {
        return;
      }

      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    navigateTree: async (targetId: string) => {
      const sessionBeforeTree = handlers.get("session_before_tree");
      const result = await sessionBeforeTree?.(
        { preparation: { targetId } },
        ctx,
      );
      const summary = (result as { summary?: { summary?: string } } | undefined)
        ?.summary?.summary;
      if (summary) {
        treeSummaries.push(summary);
      }
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    on: (event: string, registeredHandler: ExtensionHandler) => {
      handlers.set(event, registeredHandler);
    },
    registerCommand: (
      name: string,
      options: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ) => {
      commands.set(name, options.handler);
    },
    sendUserMessage: (
      content: UserMessageContent,
      options?: UserMessageOptions,
    ) => {
      if (!idle && !options?.deliverAs) {
        throw new Error(
          "Agent run is active, send a steering or followup message",
        );
      }

      sentUserMessages.push(content);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  ralphLoopExtension(pi);
  void handlers.get("session_start")?.({}, ctx);

  assert.ok(commands.get("ralph"), "expected /ralph command to be registered");
  assert.ok(
    commands.get("ralph-prompt"),
    "expected /ralph-prompt command to be registered",
  );

  return {
    commands,
    notifications,
    sentUserMessages,
    treeSummaries,
    handlers,
    ctx,
    setIdle,
    setPendingMessages,
  };
}

function getCommandHandler(
  harness: Harness,
  name: string,
): RegisteredCommand["handler"] {
  const handler = harness.commands.get(name);
  assert.ok(handler, `expected /${name} command to be registered`);
  return handler;
}

async function runCommand(
  harness: Harness,
  name: string,
  args: string,
): Promise<void> {
  const handler = getCommandHandler(harness, name);
  await handler(args, harness.ctx);
}

async function startPlanLoop(
  command: string,
  options?: {
    cwdPrefix?: string;
    planContent?: string;
  },
): Promise<Harness> {
  const cwd = mkdtempSync(
    join(tmpdir(), options?.cwdPrefix ?? "ralph-loop-plan-fixture-"),
  );
  writeFileSync(
    join(cwd, "plan.md"),
    options?.planContent ?? "# Plan\n- Do multiple tasks\n",
    "utf8",
  );

  const harness = createHarness(cwd);
  await runCommand(harness, "ralph", command);
  return harness;
}

async function emitInput(
  harness: Harness,
  text: string,
  source: InputSource,
  streamingBehavior?: StreamingBehavior,
): Promise<void> {
  const handler = harness.handlers.get("input");
  assert.ok(handler, "expected input handler to be registered");
  await handler(
    { type: "input", text, source, streamingBehavior },
    harness.ctx,
  );
}

async function emitSessionStart(
  harness: Harness,
  reason: "new" | "reload",
): Promise<void> {
  const handler = harness.handlers.get("session_start");
  assert.ok(handler, "expected session_start handler to be registered");
  await handler({ type: "session_start", reason }, harness.ctx);
}

async function emitBeforeAgentStart(
  harness: Harness,
  prompt: string,
): Promise<{ systemPrompt?: string } | undefined> {
  const handler = harness.handlers.get("before_agent_start");
  assert.ok(handler, "expected before_agent_start handler to be registered");
  return (await handler(
    {
      type: "before_agent_start",
      prompt,
      systemPrompt: "Base system prompt",
    },
    harness.ctx,
  )) as { systemPrompt?: string } | undefined;
}

async function emitAgentEnd(
  harness: Harness,
  assistantText: string,
): Promise<void> {
  const handler = harness.handlers.get("agent_end");
  assert.ok(handler, "expected agent_end handler to be registered");
  await handler(
    {
      messages: [{ role: "assistant", content: assistantText }],
    },
    harness.ctx,
  );
}

const FOLLOW_UP_DRAIN_TEST_DELAY_MS = 50;

function getLastUserMessageText(harness: Harness): string {
  return userMessageToText(harness.sentUserMessages.at(-1));
}

async function emitCurrentRalphBeforeAgentStart(
  harness: Harness,
): Promise<{ systemPrompt?: string } | undefined> {
  return emitBeforeAgentStart(harness, getLastUserMessageText(harness));
}

async function emitRalphAgentEnd(
  harness: Harness,
  assistantText: string,
): Promise<void> {
  await emitCurrentRalphBeforeAgentStart(harness);
  await emitAgentEnd(harness, assistantText);
}

async function pauseCurrentRalphTurnBySteering(
  harness: Harness,
  steeringText = "Please adjust this Ralph iteration.",
): Promise<void> {
  await emitCurrentRalphBeforeAgentStart(harness);
  await emitInput(harness, steeringText, "interactive", "steer");
}

async function flushScheduledRalphWork(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
}

async function waitForFollowUpDrainPoll(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, FOLLOW_UP_DRAIN_TEST_DELAY_MS),
  );
  await flushScheduledRalphWork();
}

function assertSingleNotification(harness: Harness, level: string): string {
  assert.equal(harness.notifications.length, 1);
  const [notification] = harness.notifications;
  assert.equal(notification?.level, level);
  return notification?.message ?? "";
}

function assertNoUserMessages(harness: Harness): void {
  assert.equal(harness.sentUserMessages.length, 0);
}

function getNotificationMessages(harness: Harness, level?: string): string[] {
  return harness.notifications
    .filter((notification) => (level ? notification.level === level : true))
    .map((notification) => notification.message);
}

async function assertRalphStatus(
  harness: Harness,
  expectedStatus: RegExp,
): Promise<void> {
  await runCommand(harness, "ralph", "status");
  assert.match(
    getNotificationMessages(harness, "info").at(-1) ?? "",
    expectedStatus,
  );
}

function assertContinuedToSecondIteration(harness: Harness): void {
  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 2);
  assert.match(
    userMessageToText(harness.sentUserMessages[1]),
    /Ralph Loop iteration 2/,
  );
}

function userMessageToText(content: UserMessageContent | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("\n");
}

function createPromptCommandFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-prompt-command-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "__tests__"), { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: "make test",
        check: "make check",
        format: "make format",
      },
    }),
    "utf8",
  );
  writeFileSync(join(cwd, "README.md"), "# Repo\n", "utf8");
  writeFileSync(
    join(cwd, "Makefile"),
    "test:\n\ttrue\ncheck:\n\ttrue\nformat:\n\ttrue\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "src", "command.ts"),
    "export const command = true;\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "__tests__", "command.test.ts"),
    "export {};\n",
    "utf8",
  );
  return cwd;
}

test("/ralph help shows usage text without sending a user message", async () => {
  const harness = createHarness();
  await runCommand(harness, "ralph", "help");

  assertNoUserMessages(harness);
  const message = assertSingleNotification(harness, "info");
  assert.match(message, /\/ralph help/);
  assert.match(message, /\/ralph <plan-file>/);
  assert.match(message, /\/ralph continue/);
  assert.doesNotMatch(message, /\/ralph prompt/);
});

test("/ralph with no arguments shows the same help text", async () => {
  const helpHarness = createHarness();
  await runCommand(helpHarness, "ralph", "help");

  const emptyHarness = createHarness();
  await runCommand(emptyHarness, "ralph", "");

  assertNoUserMessages(emptyHarness);
  assert.equal(
    assertSingleNotification(emptyHarness, "info"),
    assertSingleNotification(helpHarness, "info"),
  );
});

test("Ralph stops only for interactive textarea input", async () => {
  const interactiveHarness = await startPlanLoop("plan.md", {
    cwdPrefix: "ralph-loop-interactive-input-",
  });
  await emitInput(
    interactiveHarness,
    "I need to interrupt this loop",
    "interactive",
  );

  assert.ok(
    getNotificationMessages(interactiveHarness, "warning").some((message) =>
      /stopped by manual input/.test(message),
    ),
  );
  await assertRalphStatus(interactiveHarness, /Ralph loop is not active/);

  const nonInteractiveInputs: Array<{
    source: Exclude<InputSource, "interactive">;
    text: string;
    cwdPrefix: string;
  }> = [
    {
      source: "extension",
      text: "/simplify-code follow-up",
      cwdPrefix: "ralph-loop-extension-input-",
    },
    {
      source: "rpc",
      text: "RPC-origin follow-up",
      cwdPrefix: "ralph-loop-rpc-input-",
    },
  ];

  for (const input of nonInteractiveInputs) {
    const harness = await startPlanLoop("plan.md", {
      cwdPrefix: input.cwdPrefix,
    });
    await emitInput(harness, input.text, input.source);

    await assertRalphStatus(harness, /Ralph loop: active/);
    assert.ok(
      getNotificationMessages(harness, "warning").every(
        (message) => !/stopped by manual input/.test(message),
      ),
    );
  }
});

test("Ralph pauses on interactive steering input", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-steer-pause-",
  });

  await pauseCurrentRalphTurnBySteering(harness);

  assert.ok(
    getNotificationMessages(harness, "info").some((message) =>
      /paused by steering/i.test(message),
    ),
  );
  await assertRalphStatus(harness, /Paused by steering: yes/);

  await emitAgentEnd(harness, "Finished steered iteration.");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  await assertRalphStatus(harness, /Paused by steering: yes/);
});

test("Ralph continue resumes after paused steered turn finishes", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-steer-resume-",
  });

  await pauseCurrentRalphTurnBySteering(harness);
  await emitAgentEnd(harness, "Finished steered iteration.");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  await runCommand(harness, "ralph", "continue");
  await flushScheduledRalphWork();

  assertContinuedToSecondIteration(harness);
});

test("Ralph continue can be requested while steered turn is running", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-steer-busy-continue-",
  });

  await pauseCurrentRalphTurnBySteering(harness);
  harness.setIdle(false);

  await runCommand(harness, "ralph", "continue");

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(
    getNotificationMessages(harness, "info").some((message) =>
      /will continue after the steered turn completes/i.test(message),
    ),
  );
  await assertRalphStatus(harness, /Continue requested: yes/);

  await emitAgentEnd(harness, "Finished steered iteration.");
  await flushScheduledRalphWork();
  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(true);
  await flushScheduledRalphWork();

  assertContinuedToSecondIteration(harness);
});

test("Ralph follow-up still stops by manual input", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-followup-manual-stop-",
  });

  await emitCurrentRalphBeforeAgentStart(harness);
  await emitInput(
    harness,
    "Queue this as a normal follow-up.",
    "interactive",
    "followUp",
  );

  assert.ok(
    getNotificationMessages(harness, "warning").some((message) =>
      /stopped by manual input/.test(message),
    ),
  );
  await assertRalphStatus(harness, /Ralph loop is not active/);
});

test("Ralph continue honors completion final reason after steering", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-steer-complete-",
  });

  await pauseCurrentRalphTurnBySteering(harness);
  await emitAgentEnd(harness, "All done.\n<COMPLETE>\n");
  await flushScheduledRalphWork();

  await runCommand(harness, "ralph", "continue");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(
    getNotificationMessages(harness, "info").some((message) =>
      /Ralph loop complete/.test(message),
    ),
  );
});

test("Ralph continue honors max-iteration final reason after steering", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 1", {
    cwdPrefix: "ralph-loop-steer-max-",
  });

  await pauseCurrentRalphTurnBySteering(harness);
  await emitAgentEnd(harness, "Finished only iteration.");
  await flushScheduledRalphWork();

  await runCommand(harness, "ralph", "continue");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(
    getNotificationMessages(harness, "warning").some((message) =>
      /max-iteration cap/.test(message),
    ),
  );
});

test("Ralph clears active loops when the host starts a new or reloaded session", async () => {
  for (const reason of ["new", "reload"] as const) {
    const harness = await startPlanLoop("plan.md --max-iterations 3", {
      cwdPrefix: `ralph-loop-session-${reason}-`,
    });
    assert.equal(harness.sentUserMessages.length, 1);

    await emitSessionStart(harness, reason);
    await emitRalphAgentEnd(harness, "Finished stale iteration.");
    await flushScheduledRalphWork();

    assert.equal(harness.treeSummaries.length, 0);
    assert.equal(harness.sentUserMessages.length, 1);
    await assertRalphStatus(harness, /Ralph loop is not active/);
  }
});

test("Ralph injects its system prompt only into owned iteration turns", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-turn-ownership-",
  });
  const iterationPrompt = userMessageToText(harness.sentUserMessages[0]);

  const extensionTurn = await emitBeforeAgentStart(
    harness,
    "/simplify-code follow-up",
  );
  assert.equal(extensionTurn?.systemPrompt, undefined);

  const ralphTurn = await emitBeforeAgentStart(harness, iterationPrompt);
  assert.match(ralphTurn?.systemPrompt ?? "", /RALPH LOOP ACTIVE/);
  assert.match(ralphTurn?.systemPrompt ?? "", /Iteration: 1\/3/);
});

test("Ralph ignores agent_end events for non-owned extension turns", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-ignore-extension-agent-end-",
  });

  await emitBeforeAgentStart(harness, "/simplify-code follow-up");
  await emitAgentEnd(harness, "Simplify-code follow-up finished.");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  await assertRalphStatus(harness, /Iteration: 1\/3/);
});

test("Ralph waits for extension follow-ups to drain before collapse", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-followup-drain-",
  });
  await emitCurrentRalphBeforeAgentStart(harness);

  harness.setPendingMessages(true);
  await emitAgentEnd(harness, "Finished iteration 1.");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  harness.setPendingMessages(false);
  await waitForFollowUpDrainPoll();

  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 2);
  assert.match(
    userMessageToText(harness.sentUserMessages[1]),
    /Ralph Loop iteration 2/,
  );
});

test("collapsed Ralph iteration summary includes achieved work", async () => {
  const assistantText = [
    "Implemented /ralph help and updated command docs.",
    "Verified tests and checks pass.",
    "Documented release notes.",
  ].join("\n");

  const harness = await startPlanLoop("once plan.md", {
    cwdPrefix: "ralph-loop-summary-",
    planContent: "# Plan\n- Do one task\n",
  });

  await emitRalphAgentEnd(harness, assistantText);
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 1);
  const summary = harness.treeSummaries[0] ?? "";
  assert.match(summary, /Outcome:[\s\S]*Achieved:/);
  assert.ok(summary.includes(`Achieved: ${assistantText}`));
});

test("Ralph waits for idle before sending next iteration prompt", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-idle-boundary-",
  });
  assert.equal(harness.sentUserMessages.length, 1);

  await emitCurrentRalphBeforeAgentStart(harness);
  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished iteration 1.");
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 2);
  assert.match(
    userMessageToText(harness.sentUserMessages[1]),
    /Ralph Loop iteration 2/,
  );
});

test("Ralph does not duplicate delayed iteration starts", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-idle-dedupe-",
  });
  assert.equal(harness.sentUserMessages.length, 1);

  await emitCurrentRalphBeforeAgentStart(harness);
  harness.setIdle(false);
  await Promise.all([
    emitAgentEnd(harness, "Finished iteration 1."),
    emitAgentEnd(harness, "Finished iteration 1."),
  ]);

  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(harness.sentUserMessages.length, 2);
});

test("Ralph ignores stale delayed starts from replaced loops", async () => {
  const oldHarness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stale-old-",
  });
  await emitCurrentRalphBeforeAgentStart(oldHarness);
  oldHarness.setIdle(false);
  await emitAgentEnd(oldHarness, "Finished old iteration 1.");

  const newHarness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stale-new-",
  });
  await emitCurrentRalphBeforeAgentStart(newHarness);
  newHarness.setIdle(false);
  await emitAgentEnd(newHarness, "Finished new iteration 1.");

  oldHarness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(oldHarness.sentUserMessages.length, 1);
  assert.equal(newHarness.sentUserMessages.length, 1);

  newHarness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(oldHarness.sentUserMessages.length, 1);
  assert.equal(newHarness.sentUserMessages.length, 2);
});

test("Ralph stop request cancels delayed next iteration", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stop-boundary-",
  });
  assert.equal(harness.sentUserMessages.length, 1);

  await emitCurrentRalphBeforeAgentStart(harness);
  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished iteration 1.");
  await runCommand(harness, "ralph", "stop");

  harness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(
    getNotificationMessages(harness, "info").some((message) =>
      /will stop after the current iteration completes/.test(message),
    ),
  );
  assert.ok(
    getNotificationMessages(harness, "info").some((message) =>
      /Ralph loop stopped/.test(message),
    ),
  );
});

test("Ralph finalizes max iteration without scheduling another prompt", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 1", {
    cwdPrefix: "ralph-loop-max-boundary-",
    planContent: "# Plan\n- Do one task\n",
  });
  assert.equal(harness.sentUserMessages.length, 1);

  await emitCurrentRalphBeforeAgentStart(harness);
  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished only iteration.");

  harness.setIdle(true);
  await flushScheduledRalphWork();

  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(
    getNotificationMessages(harness, "warning").some((message) =>
      /max-iteration cap/.test(message),
    ),
  );
});

test("/ralph-prompt creates prompt artifacts and starts one synthesis iteration", async () => {
  const cwd = createPromptCommandFixture();

  const harness = createHarness(cwd);
  await runCommand(harness, "ralph-prompt", "improve command parsing coverage");

  assert.equal(harness.sentUserMessages.length, 1);
  const [iterationPrompt] = harness.sentUserMessages;
  const iterationPromptText = userMessageToText(iterationPrompt);
  assert.match(
    iterationPromptText,
    /Rewrite `plan\.md` into detailed, self-contained Ralph execution plan/,
  );
  assert.match(
    iterationPromptText,
    /Do not implement underlying repository task yet\./,
  );
  assert.match(iterationPromptText, /Keep `progress\.md` minimal\./);

  const infoMessages = getNotificationMessages(harness, "info");
  assert.ok(
    infoMessages.some((message) => /Created Ralph prompt plan:/.test(message)),
  );
  assert.ok(infoMessages.some((message) => /Ralph loop: active/.test(message)));
  assert.ok(infoMessages.some((message) => /Target: prompt/.test(message)));
  assert.ok(infoMessages.some((message) => /Iteration: 1\/1/.test(message)));

  const plansRoot = join(cwd, ".agents", "plans");
  const [taskFolder] = readdirSync(plansRoot);
  assert.ok(taskFolder, "expected prompt command to create a task folder");
  assert.match(
    taskFolder,
    /^\d{8}T\d{6}--ralph-prompt-improve-command__inprogress$/,
  );

  const planFilePath = join(plansRoot, taskFolder, "plan.md");
  const progressFilePath = join(plansRoot, taskFolder, "progress.md");
  assert.ok(existsSync(planFilePath));
  assert.ok(existsSync(progressFilePath));

  const plan = readFileSync(planFilePath, "utf8");
  assert.match(plan, /## Original User Prompt/);
  assert.match(plan, /improve command parsing coverage/);
  assert.match(plan, /## Meta-pass Deliverable/);
  assert.match(plan, /## Initial Investigation/);
  assert.match(plan, /src\/command\.ts/);
  assert.match(plan, /__tests__\/command\.test\.ts/);

  const progress = readFileSync(progressFilePath, "utf8");
  assert.match(
    progress,
    /Reserved for later `\/ralph <plan\.md>` execution history/,
  );
});
