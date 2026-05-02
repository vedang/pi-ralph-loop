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
  RegisteredCommand,
} from "@mariozechner/pi-coding-agent";

import ralphLoopExtension from "../src/index";

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type UserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type ExtensionHandler = (...args: unknown[]) => Promise<unknown> | unknown;

type Harness = ReturnType<typeof createHarness>;

function createHarness(cwd = process.cwd()): {
  commands: Map<string, RegisteredCommand["handler"]>;
  notifications: Array<{ message: string; level: string }>;
  sentUserMessages: UserMessageContent[];
  treeSummaries: string[];
  handlers: Map<string, ExtensionHandler>;
  ctx: ExtensionCommandContext;
  setIdle: (nextIdle: boolean) => void;
} {
  const commands = new Map<string, RegisteredCommand["handler"]>();
  const sentUserMessages: UserMessageContent[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const treeSummaries: string[] = [];
  const handlers = new Map<string, ExtensionHandler>();
  const idleWaiters: Array<() => void> = [];
  let idle = true;

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

async function flushAsyncContinuations(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }
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

  await emitAgentEnd(harness, assistantText);

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

  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished iteration 1.");

  assert.equal(harness.treeSummaries.length, 1);
  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(true);
  await flushAsyncContinuations();

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

  harness.setIdle(false);
  await Promise.all([
    emitAgentEnd(harness, "Finished iteration 1."),
    emitAgentEnd(harness, "Finished iteration 1."),
  ]);

  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(true);
  await flushAsyncContinuations();

  assert.equal(harness.sentUserMessages.length, 2);
});

test("Ralph ignores stale delayed starts from replaced loops", async () => {
  const oldHarness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stale-old-",
  });
  oldHarness.setIdle(false);
  await emitAgentEnd(oldHarness, "Finished old iteration 1.");

  const newHarness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stale-new-",
  });
  newHarness.setIdle(false);
  await emitAgentEnd(newHarness, "Finished new iteration 1.");

  oldHarness.setIdle(true);
  await flushAsyncContinuations();

  assert.equal(oldHarness.sentUserMessages.length, 1);
  assert.equal(newHarness.sentUserMessages.length, 1);

  newHarness.setIdle(true);
  await flushAsyncContinuations();

  assert.equal(oldHarness.sentUserMessages.length, 1);
  assert.equal(newHarness.sentUserMessages.length, 2);
});

test("Ralph stop request cancels delayed next iteration", async () => {
  const harness = await startPlanLoop("plan.md --max-iterations 3", {
    cwdPrefix: "ralph-loop-stop-boundary-",
  });
  assert.equal(harness.sentUserMessages.length, 1);

  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished iteration 1.");
  await runCommand(harness, "ralph", "stop");

  harness.setIdle(true);
  await flushAsyncContinuations();

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

  harness.setIdle(false);
  await emitAgentEnd(harness, "Finished only iteration.");

  harness.setIdle(true);
  await flushAsyncContinuations();

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
