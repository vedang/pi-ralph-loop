import { dirname, join, normalize } from "node:path";

import type { RalphBuiltinTarget, RalphRunMode } from "./contract.js";

export type { RalphBuiltinTarget, RalphRunMode } from "./contract.js";

export type RalphCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "stop" }
  | {
      kind: "start";
      runMode: RalphRunMode;
      source:
        | { kind: "builtin"; target: RalphBuiltinTarget }
        | { kind: "file"; planFile: string; progressFile?: string };
      maxIterations: number;
    };

export const RALPH_HELP_TEXT = [
  "Ralph runs an iterative planning loop from a plan file or built-in target.",
  "Use `once` for one iteration, `status` to inspect the current loop, and `stop` to stop after the current iteration.",
  "",
  "Usage:",
  "/ralph help             Show this help text",
  "/ralph <plan-file> [progress-file] [--max-iterations <n>]",
  "/ralph once <plan-file> [progress-file] [--max-iterations <n>]",
  "/ralph unit-tests [--max-iterations <n>]",
  "/ralph once unit-tests [--max-iterations <n>]",
  "/ralph clean-room [--max-iterations <n>]",
  "/ralph once clean-room [--max-iterations <n>]",
  "/ralph status",
  "/ralph stop",
].join("\n");

const DEFAULT_MAX_ITERATIONS = 50;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("Unterminated quoted argument");
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseMaxIterations(token: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(token)) {
    throw new Error(`Invalid max iteration count for ${optionName}: ${token}`);
  }

  const parsed = Number.parseInt(token, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid max iteration count for ${optionName}: ${token}`);
  }

  return parsed;
}

function parseNonStartCommand(
  name: string | undefined,
  runMode: RalphRunMode,
  positionals: string[],
  maxIterationsSpecified: boolean,
): Extract<RalphCommand, { kind: "help" | "status" | "stop" }> | null {
  if (name !== "help" && name !== "status" && name !== "stop") {
    return null;
  }

  const commandName = name;
  const capitalizedName =
    commandName === "help"
      ? "Help"
      : commandName === "status"
        ? "Status"
        : "Stop";

  if (runMode === "once") {
    throw new Error(`${capitalizedName} does not accept once mode`);
  }
  if (positionals.length !== 1) {
    throw new Error(`${capitalizedName} does not accept positional arguments`);
  }
  if (maxIterationsSpecified) {
    throw new Error(`${capitalizedName} does not accept max-iteration options`);
  }

  return { kind: commandName };
}

function createStartCommand(
  runMode: RalphRunMode,
  source: Extract<RalphCommand, { kind: "start" }>["source"],
  maxIterations: number,
): Extract<RalphCommand, { kind: "start" }> {
  return {
    kind: "start",
    source,
    runMode,
    maxIterations,
  };
}

export function parseRalphCommand(input: string): RalphCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "help" };
  }

  const tokens = tokenize(trimmed);
  const positionals: string[] = [];
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let maxIterationsSpecified = false;
  let runMode: RalphRunMode = "loop";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (token === "-n" || token === "--max-iterations") {
      const value = tokens[index + 1];
      if (!value) {
        throw new Error(`Expected value after ${token}`);
      }
      maxIterations = parseMaxIterations(value, token);
      maxIterationsSpecified = true;
      index += 1;
      continue;
    }

    if (token.startsWith("-n") && token.length > 2) {
      maxIterations = parseMaxIterations(token.slice(2), "-n");
      maxIterationsSpecified = true;
      continue;
    }

    if (token.startsWith("--max-iterations=")) {
      maxIterations = parseMaxIterations(
        token.slice("--max-iterations=".length),
        "--max-iterations",
      );
      maxIterationsSpecified = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  const onceRequested = positionals[0]?.toLowerCase() === "once";
  if (onceRequested) {
    runMode = "once";
    positionals.shift();
  }

  if (positionals.length === 0) {
    throw new Error("Missing /ralph arguments");
  }

  const first = positionals[0]?.toLowerCase();
  const nonStartCommand = parseNonStartCommand(
    first,
    runMode,
    positionals,
    maxIterationsSpecified,
  );
  if (nonStartCommand) {
    return nonStartCommand;
  }

  if (first === "unit-tests" || first === "clean-room") {
    if (positionals.length !== 1) {
      throw new Error(
        "Built-in Ralph targets do not accept extra positional arguments",
      );
    }
    return createStartCommand(
      runMode,
      { kind: "builtin", target: first },
      maxIterations,
    );
  }

  if (positionals.length > 2) {
    throw new Error("Expected `/ralph <plan-file> [progress-file]`");
  }

  const [planFile, progressFile] = positionals;
  if (!planFile) {
    throw new Error("Expected <plan-file> after /ralph");
  }

  return createStartCommand(
    runMode,
    {
      kind: "file",
      planFile: normalize(planFile),
      progressFile: progressFile ? normalize(progressFile) : undefined,
    },
    maxIterations,
  );
}

export function defaultProgressPathForPlan(planFilePath: string): string {
  return join(dirname(planFilePath), "progress.md");
}
