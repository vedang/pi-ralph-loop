import assert from "node:assert/strict";
import test from "node:test";

import { buildStatusMessage } from "../src/runtime-state";

test("buildStatusMessage reports inactive Ralph loop", () => {
  assert.equal(buildStatusMessage(null), "Ralph loop is not active.");
});

test("buildStatusMessage includes target, iteration, paths, artifacts, and stop flag", () => {
  const message = buildStatusMessage({
    active: true,
    stopping: true,
    targetName: "unit-tests",
    iteration: 2,
    maxIterations: 5,
    planFilePath: "/tmp/task/plan.md",
    progressFilePath: "/tmp/task/progress.md",
    attachmentPaths: ["/tmp/task/spec.md"],
  });

  assert.match(message, /Ralph loop: active/);
  assert.match(message, /Target: unit-tests/);
  assert.match(message, /Iteration: 2\/5/);
  assert.match(message, /Plan: \/tmp\/task\/plan\.md/);
  assert.match(message, /Progress: \/tmp\/task\/progress\.md/);
  assert.match(message, /Artifacts: \/tmp\/task\/spec\.md/);
  assert.match(message, /Stop requested: yes/);
});

test("buildStatusMessage reports steering pause and pending continue", () => {
  const message = buildStatusMessage({
    active: true,
    stopping: false,
    pausedBySteer: true,
    continueRequested: true,
    targetName: "unit-tests",
    iteration: 1,
    maxIterations: 5,
    planFilePath: "/tmp/task/plan.md",
    progressFilePath: "/tmp/task/progress.md",
    attachmentPaths: [],
  });

  assert.match(message, /Paused by steering: yes/);
  assert.match(message, /Continue requested: yes/);
});
