import { isRootcellSubcommand } from "./metadata.ts";
import type { ParsedRootcellArgs, SpyOptions } from "./types.ts";

export function parseRootcellArgs(args: readonly string[]): ParsedRootcellArgs {
  const first = args[0];
  if (isRootcellSubcommand(first)) {
    return { subcommand: first, rest: args.slice(1) };
  }
  return { subcommand: "", rest: [...args] };
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
