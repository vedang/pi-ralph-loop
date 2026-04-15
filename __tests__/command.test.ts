import assert from "node:assert/strict";
import test from "node:test";

import { defaultProgressPathForPlan, parseRalphCommand } from "../src/command";

function expectParsed(command: string, expected: unknown): void {
  assert.deepEqual(parseRalphCommand(command), expected);
}

function expectParseError(command: string, message: RegExp): void {
  assert.throws(() => parseRalphCommand(command), message);
}

const NON_START_COMMAND_CASES = [
  { kind: "help", label: "Help", maxIterationsArg: "-n 2" },
  { kind: "status", label: "Status", maxIterationsArg: "-n 2" },
  { kind: "stop", label: "Stop", maxIterationsArg: "--max-iterations 2" },
] as const;

test("parseRalphCommand handles help, status, and stop subcommands", () => {
  for (const [command, expected] of [
    ["", { kind: "help" }],
    ["   \t  ", { kind: "help" }],
  ] as const) {
    expectParsed(command, expected);
  }

  for (const { kind } of NON_START_COMMAND_CASES) {
    expectParsed(kind, { kind });
  }
});

test("parseRalphCommand rejects max-iteration flags for help, status, and stop", () => {
  for (const { kind, label, maxIterationsArg } of NON_START_COMMAND_CASES) {
    expectParseError(
      `${kind} ${maxIterationsArg}`,
      new RegExp(`${label} does not accept max-iteration options`),
    );
  }
});

test("parseRalphCommand rejects once mode for help, status, and stop", () => {
  for (const { kind, label } of NON_START_COMMAND_CASES) {
    expectParseError(
      `once ${kind}`,
      new RegExp(`${label} does not accept once mode`),
    );
  }
});

test("parseRalphCommand parses a built-in Ralph target", () => {
  expectParsed("unit-tests --max-iterations 7", {
    kind: "start",
    runMode: "loop",
    source: { kind: "builtin", target: "unit-tests" },
    maxIterations: 7,
  });
});

test("parseRalphCommand parses once mode for built-in Ralph targets", () => {
  expectParsed("once unit-tests --max-iterations 2", {
    kind: "start",
    runMode: "once",
    source: { kind: "builtin", target: "unit-tests" },
    maxIterations: 2,
  });
});

test("parseRalphCommand parses explicit plan and progress files", () => {
  expectParsed("docs/plan.md docs/progress.md -n 3", {
    kind: "start",
    runMode: "loop",
    source: {
      kind: "file",
      planFile: "docs/plan.md",
      progressFile: "docs/progress.md",
    },
    maxIterations: 3,
  });
});

test("parseRalphCommand parses once mode for explicit plan files", () => {
  expectParsed("once docs/plan.md docs/progress.md -n 1", {
    kind: "start",
    runMode: "once",
    source: {
      kind: "file",
      planFile: "docs/plan.md",
      progressFile: "docs/progress.md",
    },
    maxIterations: 1,
  });
});

test("parseRalphCommand supports quoted file paths", () => {
  expectParsed('"docs/my plan.md" "docs/my progress.md"', {
    kind: "start",
    runMode: "loop",
    source: {
      kind: "file",
      planFile: "docs/my plan.md",
      progressFile: "docs/my progress.md",
    },
    maxIterations: 50,
  });
});

test("defaultProgressPathForPlan uses workflow-native progress.md next to the plan", () => {
  assert.equal(
    defaultProgressPathForPlan(
      "/repo/.agents/plans/20260410T210000--ralph-unit-tests-coverage__inprogress/plan.md",
    ),
    "/repo/.agents/plans/20260410T210000--ralph-unit-tests-coverage__inprogress/progress.md",
  );
});
