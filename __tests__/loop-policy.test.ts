import assert from "node:assert/strict";
import test from "node:test";

import { getCollapseOutcome, getFinalReason } from "../src/loop-policy";

test("getFinalReason prefers completion over all other stop reasons", () => {
  assert.equal(
    getFinalReason(
      {
        stopping: true,
        runMode: "once",
        iteration: 9,
        maxIterations: 1,
      },
      "Finished the work.\n<COMPLETE>\n",
    ),
    "complete",
  );
});

test("getFinalReason preserves stop, once, max, and continue precedence", () => {
  assert.equal(
    getFinalReason(
      { stopping: true, runMode: "loop", iteration: 1, maxIterations: 5 },
      "not done",
    ),
    "stop",
  );
  assert.equal(
    getFinalReason(
      { stopping: false, runMode: "once", iteration: 1, maxIterations: 1 },
      "not done",
    ),
    "once",
  );
  assert.equal(
    getFinalReason(
      { stopping: false, runMode: "loop", iteration: 5, maxIterations: 5 },
      "not done",
    ),
    "max",
  );
  assert.equal(
    getFinalReason(
      { stopping: false, runMode: "loop", iteration: 2, maxIterations: 5 },
      "not done",
    ),
    null,
  );
});

test("getCollapseOutcome describes each Ralph outcome consistently", () => {
  assert.match(getCollapseOutcome("complete"), /entire Ralph plan/i);
  assert.match(getCollapseOutcome("stop"), /stopped by the user/i);
  assert.match(getCollapseOutcome("once"), /single-iteration mode completed/i);
  assert.match(getCollapseOutcome("max"), /max-iteration cap/i);
  assert.match(
    getCollapseOutcome(null),
    /re-read the plan and progress files/i,
  );
});
