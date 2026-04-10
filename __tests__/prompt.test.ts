import assert from "node:assert/strict";
import test from "node:test";

import { buildIterationPrompt, buildRalphSystemPrompt } from "../src/prompt";

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
  assert.match(prompt, /Make a git commit for this iteration\./);
  assert.match(
    prompt,
    /Run relevant feedback loops .* before you finish this task\./i,
  );
  assert.match(
    prompt,
    /Do not consider the task complete while relevant feedback loops are failing\./i,
  );
  assert.match(prompt, /ONLY WORK ON A SINGLE TASK PER ITERATION\./);
});

test("buildRalphSystemPrompt summarizes the active Ralph contract", () => {
  const prompt = buildRalphSystemPrompt({
    basePrompt: "BASE PROMPT",
    iteration: 2,
    maxIterations: 5,
    planFilePath: "/tmp/task/plan.md",
    progressFilePath: "/tmp/task/progress.md",
  });

  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /RALPH LOOP ACTIVE/);
  assert.match(prompt, /Iteration: 2\/5/);
  assert.match(prompt, /Plan file: \/tmp\/task\/plan\.md/);
  assert.match(prompt, /Progress file: \/tmp\/task\/progress\.md/);
  assert.match(prompt, /make a git commit for the iteration/i);
});
