import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

function createHarness(cwd = process.cwd()): {
  handler: RegisteredCommand["handler"];
  notifications: Array<{ message: string; level: string }>;
  sentUserMessages: UserMessageContent[];
  treeSummaries: string[];
  handlers: Map<string, ExtensionHandler>;
  ctx: ExtensionCommandContext;
} {
  let handler: RegisteredCommand["handler"] | undefined;
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
      _name: string,
      options: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ) => {
      handler = options.handler;
    },
    sendUserMessage: (content: UserMessageContent) => {
      sentUserMessages.push(content);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  ralphLoopExtension(pi);

  assert.ok(handler, "expected /ralph command to be registered");

  return {
    handler,
    notifications,
    sentUserMessages,
    treeSummaries,
    handlers,
    ctx,
  };
}

test("/ralph help shows usage text without sending a user message", async () => {
  const { handler, notifications, sentUserMessages, ctx } = createHarness();

  await handler("help", ctx);

  assert.equal(sentUserMessages.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /\/ralph help/);
  assert.match(notifications[0]?.message ?? "", /\/ralph <plan-file>/);
});

test("/ralph with no arguments shows the same help text", async () => {
  const helpHarness = createHarness();
  await helpHarness.handler("help", helpHarness.ctx);

  const emptyHarness = createHarness();
  await emptyHarness.handler("", emptyHarness.ctx);

  assert.equal(emptyHarness.sentUserMessages.length, 0);
  assert.equal(emptyHarness.notifications.length, 1);
  assert.equal(emptyHarness.notifications[0]?.level, "info");
  assert.equal(
    emptyHarness.notifications[0]?.message,
    helpHarness.notifications[0]?.message,
  );
});

test("collapsed Ralph iteration summary includes achieved work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-summary-"));
  writeFileSync(join(cwd, "plan.md"), "# Plan\n- Do one task\n", "utf8");

  const harness = createHarness(cwd);
  await harness.handler("plan.md", harness.ctx);

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
