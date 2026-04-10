import assert from "node:assert/strict";
import test from "node:test";

import { defaultProgressPathForPlan, parseRalphCommand } from "../src/command";

test("parseRalphCommand handles status and stop subcommands", () => {
  assert.deepEqual(parseRalphCommand("status"), { kind: "status" });
  assert.deepEqual(parseRalphCommand("stop"), { kind: "stop" });
});

test("parseRalphCommand rejects max-iteration flags for status and stop", () => {
  assert.throws(
    () => parseRalphCommand("status -n 2"),
    /Status does not accept max-iteration options/,
  );
  assert.throws(
    () => parseRalphCommand("stop --max-iterations 2"),
    /Stop does not accept max-iteration options/,
  );
});

test("parseRalphCommand parses a built-in Ralph target", () => {
  assert.deepEqual(parseRalphCommand("unit-tests --max-iterations 7"), {
    kind: "start",
    source: { kind: "builtin", target: "unit-tests" },
    maxIterations: 7,
  });
});

test("parseRalphCommand parses explicit plan and progress files", () => {
  assert.deepEqual(parseRalphCommand("docs/plan.md docs/progress.md -n 3"), {
    kind: "start",
    source: {
      kind: "file",
      planFile: "docs/plan.md",
      progressFile: "docs/progress.md",
    },
    maxIterations: 3,
  });
});

test("parseRalphCommand supports quoted file paths", () => {
  assert.deepEqual(
    parseRalphCommand('"docs/my plan.md" "docs/my progress.md"'),
    {
      kind: "start",
      source: {
        kind: "file",
        planFile: "docs/my plan.md",
        progressFile: "docs/my progress.md",
      },
      maxIterations: 50,
    },
  );
});

test("defaultProgressPathForPlan uses workflow-native progress.md next to the plan", () => {
  assert.equal(
    defaultProgressPathForPlan(
      "/repo/.agents/plans/20260410T210000--ralph-unit-tests-coverage__inprogress/plan.md",
    ),
    "/repo/.agents/plans/20260410T210000--ralph-unit-tests-coverage__inprogress/progress.md",
  );
});
