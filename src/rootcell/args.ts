import { isRootcellSubcommand } from "./metadata.ts";
import { validateInstanceName } from "./instance.ts";
import type { ParsedRootcellArgs, SpyOptions } from "./types.ts";

export function parseRootcellArgs(args: readonly string[]): ParsedRootcellArgs {
  let instanceName = "default";
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    if (arg === "--instance") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--instance requires a name");
      }
      instanceName = validateInstanceName(value);
      index += 2;
      continue;
    }
    if (arg?.startsWith("--instance=")) {
      instanceName = validateInstanceName(arg.slice("--instance=".length));
      index += 1;
      continue;
    }
    break;
  }

  const first = args[index];
  if (isRootcellSubcommand(first)) {
    return { instanceName, subcommand: first, rest: args.slice(index + 1) };
  }
  return { instanceName, subcommand: "", rest: args.slice(index) };
}

export function parseSpyOptions(args: readonly string[]): SpyOptions {
  let raw = false;
  let dedupe = true;
  let tui = false;
  for (const arg of args) {
    switch (arg) {
      case "--raw":
        raw = true;
        break;
      case "--no-dedupe":
        dedupe = false;
        break;
      case "--tui":
        tui = true;
        break;
      case "-h":
      case "--help":
        break;
      default:
        throw new Error(`unknown spy option: ${arg}`);
    }
  }
  return { raw, dedupe, tui };
}

export function hasHelp(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-h" || arg === "--help");
}
