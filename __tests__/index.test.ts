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
type ExtensionHandler = (...args: unknown[]) => Promise<unknown> | unknown;

type Harness = ReturnType<typeof createHarness>;

function createHarness(cwd = process.cwd()): {
  commands: Map<string, RegisteredCommand["handler"]>;
  notifications: Array<{ message: string; level: string }>;
  sentUserMessages: UserMessageContent[];
  treeSummaries: string[];
  handlers: Map<string, ExtensionHandler>;
  ctx: ExtensionCommandContext;
} {
  const commands = new Map<string, RegisteredCommand["handler"]>();
  const sentUserMessages: UserMessageContent[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const treeSummaries: string[] = [];
  const handlers = new Map<string, ExtensionHandler>();

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
    isIdle: () => true,
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
    sendUserMessage: (content: UserMessageContent) => {
      sentUserMessages.push(content);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  ralphLoopExtension(pi);

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

function assertSingleNotification(harness: Harness, level: string): string {
  assert.equal(harness.notifications.length, 1);
  const [notification] = harness.notifications;
  assert.equal(notification?.level, level);
  return notification?.message ?? "";
}

function assertNoUserMessages(harness: Harness): void {
  assert.equal(harness.sentUserMessages.length, 0);
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
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-summary-"));
  writeFileSync(join(cwd, "plan.md"), "# Plan\n- Do one task\n", "utf8");

  const harness = createHarness(cwd);
  await runCommand(harness, "ralph", "plan.md");

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd, "expected agent_end handler to be registered");

  await agentEnd(
    {
      messages: [
        {
          role: "assistant",
          content:
            "Implemented /ralph help and updated command docs.\nVerified tests and checks pass.",
        },
      ],
    },
    harness.ctx,
  );

  assert.equal(harness.treeSummaries.length, 1);
  assert.match(harness.treeSummaries[0] ?? "", /Achieved:/);
  assert.match(
    harness.treeSummaries[0] ?? "",
    /Implemented \/ralph help and updated command docs\./,
  );
});

test("/ralph-prompt creates a prompt-seeded task folder without starting the loop", async () => {
  const cwd = createPromptCommandFixture();

  const harness = createHarness(cwd);
  await runCommand(harness, "ralph-prompt", "improve command parsing coverage");

  assertNoUserMessages(harness);
  const message = assertSingleNotification(harness, "info");
  assert.match(message, /Created Ralph prompt plan:/);
  assert.match(message, /Next: `\/ralph /);

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
  assert.match(plan, /## User Prompt/);
  assert.match(plan, /improve command parsing coverage/);
  assert.match(plan, /## Initial Investigation/);
  assert.match(plan, /src\/command\.ts/);
  assert.match(plan, /__tests__\/command\.test\.ts/);
});
