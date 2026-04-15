import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { seedPromptTarget } from "../src/prompt-target";

test("seedPromptTarget creates meta-prompt artifacts with repo investigation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ralph-loop-prompt-target-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "__tests__"), { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: "make test",
        check: "make check",
        format: "make format",
      },
    }),
    "utf8",
  );
  writeFileSync(join(cwd, "README.md"), "# Repo\n", "utf8");
  writeFileSync(
    join(cwd, "Makefile"),
    "test:\n\ttrue\ncheck:\n\ttrue\nformat:\n\ttrue\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "src", "command.ts"),
    "export const command = true;\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "src", "prompt.ts"),
    "export const prompt = true;\n",
    "utf8",
  );
  writeFileSync(
    join(cwd, "__tests__", "command.test.ts"),
    "export {};\n",
    "utf8",
  );

  const seeded = seedPromptTarget({
    cwd,
    promptText: "improve command parsing coverage",
    now: new Date(2026, 3, 10, 21, 18, 30),
  });

  assert.ok(
    seeded.taskDir.endsWith(
      ".agents/plans/20260410T211830--ralph-prompt-improve-command__inprogress",
    ),
  );
  assert.equal(existsSync(seeded.planFilePath), true);
  assert.equal(existsSync(seeded.progressFilePath), true);

  const plan = readFileSync(seeded.planFilePath, "utf8");
  assert.match(plan, /^# Plan: Ralph prompt/m);
  assert.match(plan, /## Goal/);
  assert.match(plan, /## Original User Prompt/);
  assert.match(plan, /improve command parsing coverage/);
  assert.match(plan, /## Meta-pass Deliverable/);
  assert.match(
    plan,
    /Rewrite `plan\.md` into detailed, self-contained Ralph execution plan/,
  );
  assert.match(plan, /Do not implement underlying repository task yet\./);
  assert.match(plan, /Leave `progress\.md` minimal/);
  assert.match(plan, /## Initial Investigation/);
  assert.match(plan, /src\/command\.ts/);
  assert.match(plan, /__tests__\/command\.test\.ts/);
  assert.match(plan, /## Requirements For Rewritten Plan/);
  assert.match(plan, /Preserve explicit user constraints/);
  assert.match(plan, /## Meta-pass Rules/);

  const progress = readFileSync(seeded.progressFilePath, "utf8");
  assert.match(progress, /# Progress: Ralph prompt/);
  assert.match(
    progress,
    /Reserved for later `\/ralph <plan\.md>` execution history/,
  );
});
