import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { type RalphCommand, defaultProgressPathForPlan } from "./command.js";
import { RALPH_CUSTOM_TARGET, type RalphTargetName } from "./contract.js";
import { buildProgressTemplate, seedBuiltinTarget } from "./targets.js";

export interface ResolvedRalphStart {
  targetName: RalphTargetName;
  planFilePath: string;
  progressFilePath: string;
  attachmentPaths: string[];
}

function ensureProgressFile(progressFilePath: string): void {
  if (existsSync(progressFilePath)) {
    return;
  }

  mkdirSync(dirname(progressFilePath), { recursive: true });
  writeFileSync(
    progressFilePath,
    buildProgressTemplate(RALPH_CUSTOM_TARGET),
    "utf8",
  );
}

export function resolveStartCommand(
  command: Extract<RalphCommand, { kind: "start" }>,
  ctx: ExtensionCommandContext,
): ResolvedRalphStart {
  if (command.source.kind === "builtin") {
    const seeded = seedBuiltinTarget({
      cwd: ctx.cwd,
      target: command.source.target,
      now: new Date(),
    });
    return {
      targetName: command.source.target,
      planFilePath: seeded.planFilePath,
      progressFilePath: seeded.progressFilePath,
      attachmentPaths: seeded.attachmentPaths,
    };
  }

  const planFilePath = resolve(ctx.cwd, command.source.planFile);
  if (!existsSync(planFilePath)) {
    throw new Error(`Plan file does not exist: ${planFilePath}`);
  }

  const progressFilePath = resolve(
    ctx.cwd,
    command.source.progressFile ??
      defaultProgressPathForPlan(command.source.planFile),
  );
  ensureProgressFile(progressFilePath);

  return {
    targetName: RALPH_CUSTOM_TARGET,
    planFilePath,
    progressFilePath,
    attachmentPaths: [],
  };
}
