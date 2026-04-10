import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { seedBuiltinTarget } from "../src/targets";

test("seedBuiltinTarget creates workflow-native unit-tests artifacts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-unit-tests-"));
  const seeded = seedBuiltinTarget({
    cwd,
    target: "unit-tests",
    now: new Date(2026, 3, 10, 21, 15, 30),
  });

  assert.ok(
    seeded.taskDir.endsWith(
      ".agents/plans/20260410T211530--ralph-unit-tests-coverage__inprogress",
    ),
  );
  assert.equal(existsSync(seeded.planFilePath), true);
  assert.equal(existsSync(seeded.progressFilePath), true);

  const plan = readFileSync(seeded.planFilePath, "utf8");
  assert.match(plan, /ONLY WORK ON A SINGLE TASK PER ITERATION\./);
  assert.match(plan, /Keep production code changes minimal/i);
  assert.match(plan, /all necessary automated tests/i);
});

test("seedBuiltinTarget creates clean-room artifacts including spec.md", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-clean-room-"));
  const seeded = seedBuiltinTarget({
    cwd,
    target: "clean-room",
    now: new Date(2026, 3, 10, 21, 16, 45),
  });

  const specPath = join(seeded.taskDir, "spec.md");
  assert.equal(existsSync(specPath), true);
  assert.deepEqual(seeded.attachmentPaths, [specPath]);

  const plan = readFileSync(seeded.planFilePath, "utf8");
  assert.match(plan, /spec\.md/);
  assert.match(plan, /avoid copying implementation code verbatim/i);
  assert.match(plan, /clean-room reimplementation/i);
});

test("seedBuiltinTarget rejects task-folder timestamp collisions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-collision-"));
  const now = new Date(2026, 3, 10, 21, 17, 30);

  seedBuiltinTarget({ cwd, target: "unit-tests", now });

  assert.throws(
    () => seedBuiltinTarget({ cwd, target: "unit-tests", now }),
    /Built-in Ralph task directory already exists/,
  );
});
