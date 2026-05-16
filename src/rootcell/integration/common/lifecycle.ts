import { runInherited } from "../../process.ts";
import { findRepoDir } from "./fixtures.ts";
import { selectedIntegrationProvider } from "./provider-spec.ts";

interface ParsedIntegrationCliArgs {
  readonly clean: boolean;
  readonly teardown: boolean;
}

export async function runIntegrationCli(args: readonly string[], importMetaUrl: string): Promise<number> {
  const parsed = parseArgs(args);
  const repoDir = findRepoDir(importMetaUrl);
  const provider = selectedIntegrationProvider();

  if (parsed.teardown) {
    console.error("test: deleting integration test VMs...");
    await provider.removeTestState(repoDir);
    return 0;
  }

  if (parsed.clean) {
    console.error("test: deleting integration test VMs for a fresh provision...");
    await provider.removeTestState(repoDir);
  }

  const status = runInherited("bun", ["run", "test:integration"], {
    cwd: repoDir,
    allowFailure: true,
  }).status;
  try {
    await provider.stopTestResources(repoDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return status === 0 ? 1 : status;
  }
  return status;
}

function parseArgs(args: readonly string[]): ParsedIntegrationCliArgs {
  const first = args[0] ?? "";
  switch (first) {
    case "":
      return { clean: false, teardown: false };
    case "--clean":
      return { clean: true, teardown: false };
    case "--teardown":
      return { clean: false, teardown: true };
    default:
      console.error(`usage: ${process.argv[1] ?? "./test"} [--clean|--teardown]`);
      process.exit(2);
  }
}
