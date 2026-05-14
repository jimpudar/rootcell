import { existsSync, readdirSync } from "node:fs";
import yargs from "yargs/yargs";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { isRootcellSubcommand, ROOTCELL_SUBCOMMANDS, type RootcellSubcommand } from "./metadata.ts";
import { validateInstanceName } from "./instance.ts";
import type { ParsedRootcellArgs, SpyOptions } from "./types.ts";

const DEFAULT_SPY_OPTIONS: SpyOptions = { raw: false, dedupe: true, tui: false };

interface GlobalArgs {
  readonly instance?: string | readonly string[];
}

interface GuestArgs extends GlobalArgs {
  readonly command?: readonly string[];
  readonly "--"?: readonly string[];
}

interface SpyArgs extends GlobalArgs {
  readonly raw?: boolean;
  readonly dedupe?: boolean;
  readonly tui?: boolean;
}

interface ImagesArgs extends GlobalArgs {
  readonly action?: string;
}

type ParserArgv<T> = Argv<T>;

function subcommandDescription(name: RootcellSubcommand): string {
  return ROOTCELL_SUBCOMMANDS.find((subcommand) => subcommand.name === name)?.description ?? "";
}

function lastString(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  return value[value.length - 1];
}

function instanceName(argv: GlobalArgs): string {
  return validateInstanceName(lastString(argv.instance) ?? "default");
}

function stringArray(value: readonly string[] | string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
}

function rootcellSubcommand(
  name: RootcellSubcommand,
  builder?: (argv: ParserArgv<GlobalArgs>) => ParserArgv<GlobalArgs>,
): readonly [
  string,
  string,
  (argv: ParserArgv<GlobalArgs>) => ParserArgv<GlobalArgs>,
] {
  return [
    name,
    subcommandDescription(name),
    (argv) => (builder?.(argv) ?? argv).demandCommand(0, 0).strictOptions(),
  ];
}

function completeInstances(current: string): readonly string[] {
  const root = ".rootcell/instances";
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(current))
    .map((entry) => entry.name);
}

function completion(
  current: string,
  argv: ArgumentsCamelCase<GlobalArgs>,
  completionFilter: (done: (error: Error | null, completions: string[] | undefined) => void) => void,
  done: (completions: string[]) => void,
): void {
  completionFilter((error, completions) => {
    if (error !== null) {
      throw error;
    }
    const defaults = (completions ?? []).filter((completion) => !completion.startsWith("$0"));
    const currentInstance = lastString(argv.instance);
    if (currentInstance === current) {
      done([...completeInstances(current), ...defaults]);
      return;
    }
    done(defaults);
  });
}

function createParser(args: readonly string[]): Argv<GuestArgs & SpyArgs & ImagesArgs> {
  return yargs([...args])
    .scriptName("rootcell")
    .exitProcess(false)
    .version(false)
    .parserConfiguration({
      "greedy-arrays": false,
      "populate--": true,
      "unknown-options-as-args": true,
    })
    .usage("$0 [command..]\n\nStart the rootcell agent VM and run a command.")
    .option("instance", {
      alias: "i",
      describe: "select rootcell instance",
      type: "string",
      default: "default",
      normalize: false,
    })
    // yargs' completion request flag is normally implicit. With
    // unknown-options-as-args enabled for command pass-through, it must be
    // declared so completion requests still reach yargs.
    .option("get-yargs-completions", {
      type: "string",
      hidden: true,
    })
    .command(...rootcellSubcommand("provision"))
    .command(...rootcellSubcommand("allow"))
    .command(...rootcellSubcommand("pubkey"))
    .command(
      "images <action>",
      subcommandDescription("images"),
      (argv: ParserArgv<ImagesArgs>) => argv.positional("action", {
        choices: ["build"] as const,
        describe: "image action",
        type: "string",
      }).demandCommand(0, 0).strictOptions(),
    )
    .command(
      "spy",
      subcommandDescription("spy"),
      (argv: ParserArgv<SpyArgs>) => argv
        .parserConfiguration({ "unknown-options-as-args": false })
        .option("raw", {
          describe: "also print sanitized raw JSON bodies",
          type: "boolean",
          default: false,
        })
        .option("dedupe", {
          describe: "elide repeated cache-marked prompt prefixes",
          type: "boolean",
          default: true,
        })
        .option("tui", {
          describe: "browse captured traffic in an interactive Textual TUI",
          type: "boolean",
          default: false,
        })
        .demandCommand(0, 0)
        .strictOptions(),
    )
    .command(
      "$0 [command..]",
      "run a command inside the agent VM; defaults to an interactive shell",
      (argv: ParserArgv<GuestArgs>) => argv.positional("command", {
        array: true,
        describe: "command and arguments to run inside the agent VM",
        type: "string",
      }),
    )
    .example("$0", "open an interactive shell inside the agent VM")
    .example("$0 pi", "run pi inside the agent VM")
    .example("$0 -- nix flake update", "run any command inside the agent VM")
    .example("$0 --instance dev allow", "reload allowlists for the dev instance")
    .completion("completion", "generate shell completion script", completion)
    .help()
    .wrap(Math.min(100, yargs().terminalWidth()))
    .fail(fail);
}

export function parseRootcellArgs(args: readonly string[]): ParsedRootcellArgs {
  const argv = createParser(args).parseSync();
  const firstToken = firstRootcellToken(args);
  if (
    argv.help === true
    || firstToken === "help"
    || firstToken === "completion"
    || argv["get-yargs-completions"] !== undefined
  ) {
    return { kind: "handled", status: 0 };
  }

  const subcommand = parsedSubcommand(argv);
  if (subcommand !== undefined) {
    return {
      kind: "run",
      instanceName: instanceName(argv),
      subcommand,
      rest: subcommand === "images" ? stringArray(argv.action) : [],
      spyOptions: subcommand === "spy"
        ? { raw: argv.raw ?? false, dedupe: argv.dedupe ?? true, tui: argv.tui ?? false }
        : DEFAULT_SPY_OPTIONS,
    };
  }

  const afterTerminator = stringArray(argv["--"]);
  const rest = [...stringArray(argv.command), ...afterTerminator];
  const first = rest[0];
  if (first?.startsWith("-") === true && afterTerminator.length === 0) {
    throw new Error(`Unknown argument: ${first.replace(/^-+/, "")}`);
  }
  return {
    kind: "run",
    instanceName: instanceName(argv),
    subcommand: "",
    rest,
    spyOptions: DEFAULT_SPY_OPTIONS,
  };
}

function fail(message: string, error: Error): never {
  throw error instanceof Error ? error : new Error(message);
}

function parsedSubcommand(argv: ArgumentsCamelCase<GuestArgs & SpyArgs & ImagesArgs>): RootcellSubcommand | undefined {
  const command = argv._[0];
  return typeof command === "string" && isRootcellSubcommand(command) ? command : undefined;
}

function firstRootcellToken(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") {
      return undefined;
    }
    if (arg === "--instance" || arg === "-i" || arg === "--get-yargs-completions") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=") || (arg.startsWith("-i") && arg.length > 2)) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}
