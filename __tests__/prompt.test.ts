import assert from "node:assert/strict";
import test from "node:test";

import { buildIterationPrompt } from "../src/prompt";

test("buildIterationPrompt attaches plan, progress, and extra artifacts", () => {
  const prompt = buildIterationPrompt({
    iteration: 3,
    planFilePath: "/tmp/task/plan.md",
    progressFilePath: "/tmp/task/progress.md",
    attachmentPaths: ["/tmp/task/spec.md"],
  });

  assert.match(prompt, /^@\/tmp\/task\/plan\.md/m);
  assert.match(prompt, /^@\/tmp\/task\/progress\.md/m);
  assert.match(prompt, /^@\/tmp\/task\/spec\.md/m);
  assert.match(prompt, /Ralph Loop iteration 3/);
  assert.match(prompt, /ONLY WORK ON A SINGLE TASK PER ITERATION\./);
});
