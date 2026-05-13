import { spawn, spawnSync } from "node:child_process";
import type { SpawnOptions, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { CommandResult, InheritedCommandResult } from "./types.ts";

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly allowFailure?: boolean;
}

export interface InheritOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowFailure?: boolean;
  readonly ignoredOutput?: boolean;
}

function statusFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

export function runCapture(command: string, args: readonly string[], options: RunOptions = {}): CommandResult {
  const syncOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.stdin,
  };
  const result = spawnSync(command, [...args], syncOptions);
  const status = result.status ?? statusFromSignal(result.signal);
  const rawStdout: unknown = result.stdout;
  const rawStderr: unknown = result.stderr;
  const stdout = typeof rawStdout === "string" ? rawStdout : "";
  const stderr = typeof rawStderr === "string" ? rawStderr : "";
  const output: CommandResult = {
    status,
    stdout,
    stderr: result.error instanceof Error && stderr.length === 0 ? result.error.message : stderr,
  };
  if (!options.allowFailure && status !== 0) {
    throw new CommandError(command, args, output);
  }
  return output;
}

export function runInherited(command: string, args: readonly string[], options: InheritOptions = {}): InheritedCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.ignoredOutput ? "ignore" : "inherit",
    encoding: "utf8",
  });
  const status = result.status ?? statusFromSignal(result.signal);
  if (!options.allowFailure && status !== 0) {
    throw new CommandError(command, args, { status, stdout: "", stderr: "" });
  }
  return { status };
}

export function runInputInherited(command: string, args: readonly string[], stdin: string, options: InheritOptions = {}): InheritedCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: stdin,
    stdio: ["pipe", options.ignoredOutput ? "ignore" : "inherit", options.ignoredOutput ? "ignore" : "inherit"],
    encoding: "utf8",
  });
  const status = result.status ?? statusFromSignal(result.signal);
  if (!options.allowFailure && status !== 0) {
    throw new CommandError(command, args, { status, stdout: "", stderr: "" });
  }
  return { status };
}

export async function runAsyncInherited(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<number> {
  const child = spawn(command, [...args], {
    ...options,
    stdio: "inherit",
    env: options.env ?? process.env,
  });

  return await new Promise<number>((resolve) => {
    child.on("close", (code, signal) => {
      resolve(code ?? statusFromSignal(signal));
    });
  });
}

export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly result: CommandResult;

  constructor(command: string, args: readonly string[], result: CommandResult) {
    super(`command failed (${String(result.status)}): ${[command, ...args].join(" ")}`);
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

export function commandExists(command: string): boolean {
  return runCapture("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    allowFailure: true,
  }).status === 0;
}
