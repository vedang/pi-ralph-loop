import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@mariozechner/pi-coding-agent";

import ralphLoopExtension from "../src/index";

type UserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

function createHarness(): {
  handler: RegisteredCommand["handler"];
  notifications: Array<{ message: string; level: string }>;
  sentUserMessages: UserMessageContent[];
  ctx: ExtensionCommandContext;
} {
  let handler: RegisteredCommand["handler"] | undefined;
  const sentUserMessages: UserMessageContent[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const pi = {
    on: () => {},
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

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
    },
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;

  return { handler, notifications, sentUserMessages, ctx };
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
