import { dirname, join, normalize } from "node:path";

export type RalphBuiltinTarget = "unit-tests" | "clean-room";
export type RalphRunMode = "loop" | "once";

export type RalphCommand =
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
): Extract<RalphCommand, { kind: "status" | "stop" }> | null {
  if (name !== "status" && name !== "stop") {
    return null;
  }

  if (runMode === "once") {
    throw new Error(
      `${name === "status" ? "Status" : "Stop"} does not accept once mode`,
    );
  }
  if (positionals.length !== 1) {
    throw new Error(
      `${name === "status" ? "Status" : "Stop"} does not accept positional arguments`,
    );
  }
  if (maxIterationsSpecified) {
    throw new Error(
      `${name === "status" ? "Status" : "Stop"} does not accept max-iteration options`,
    );
  }

  return { kind: name };
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
    throw new Error("Missing /ralph arguments");
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
