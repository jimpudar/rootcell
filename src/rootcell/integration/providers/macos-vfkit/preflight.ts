import { commandExists } from "../../../process.ts";

export function preflightMacOsVfkitIntegration(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macos-vfkit integration tests require macOS");
  }
  if (process.arch !== "arm64") {
    throw new Error("macos-vfkit integration tests currently require Apple Silicon arm64 hosts");
  }
  for (const tool of [
    { command: "vfkit", envVar: "ROOTCELL_VFKIT" },
    { command: "python3", envVar: "ROOTCELL_PYTHON" },
    { command: "zstd", envVar: "ROOTCELL_ZSTD" },
    { command: "ssh" },
    { command: "curl" },
  ] as const) {
    if (!toolAvailable(tool.command, tool.envVar)) {
      throw new Error(`macos-vfkit integration tests require '${tool.command}' on PATH or ${tool.envVar ?? "a configured override"}`);
    }
  }
  return Promise.resolve();
}

function toolAvailable(command: string, envVar?: string): boolean {
  return (envVar !== undefined && process.env[envVar] !== undefined && process.env[envVar].length > 0)
    || commandExists(command);
}
