import assert from "node:assert/strict";
import test from "node:test";

import { hasCompleteSigil } from "../src/text";

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
