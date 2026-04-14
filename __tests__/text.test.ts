import assert from "node:assert/strict";
import test from "node:test";

import { hasCompleteSigil, summarizeIterationAchievement } from "../src/text";

test("hasCompleteSigil detects the standalone completion sigil", () => {
  assert.equal(hasCompleteSigil("Done with the work.\n<COMPLETE>\n"), true);
});

test("hasCompleteSigil ignores inline mentions of the completion sigil", () => {
  assert.equal(
    hasCompleteSigil(
      "Mentioning <COMPLETE> in prose should not stop the loop.",
    ),
    false,
  );
});

test("summarizeIterationAchievement keeps the first two sentences", () => {
  assert.equal(
    summarizeIterationAchievement(
      "Implemented /ralph help. Updated docs. Added more cleanup.",
    ),
    "Implemented /ralph help. Updated docs.",
  );
});

test("summarizeIterationAchievement strips standalone completion sigils", () => {
  assert.equal(
    summarizeIterationAchievement("Implemented parser changes.\n<COMPLETE>\n"),
    "Implemented parser changes.",
  );
});

test("summarizeIterationAchievement respects maxLength when truncating", () => {
  const summary = summarizeIterationAchievement(
    "Implemented parser changes and docs updates.",
    { maxLength: 12 },
  );

  assert.ok(summary.length <= 12);
  assert.match(summary, /…$/);
});
