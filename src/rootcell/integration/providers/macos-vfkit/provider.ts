import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IntegrationProviderSpec } from "../../common/provider-spec.ts";
import {
  AGENT_VM_NAME,
  FIREWALL_VM_NAME,
  LIFECYCLE_INSTANCE,
  TEST_INSTANCE,
} from "../../common/fixtures.ts";
import { runCapture } from "../../../process.ts";
import type { RootcellConfig } from "../../../types.ts";
import { MacOsVfkitNetworkProvider, type VfkitNetworkAttachment } from "../../../providers/macos-vfkit-network.ts";
import { VfkitVmProvider } from "../../../providers/vfkit.ts";
import type { ProviderBundle } from "../../../providers/types.ts";
import { preflightMacOsVfkitIntegration } from "./preflight.ts";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const macOsVfkitIntegrationProvider: IntegrationProviderSpec<VfkitNetworkAttachment> = {
  id: "macos-vfkit",
  platform: "darwin",
  architecture: "arm64",
  guestArchitecture: "aarch64-linux",
  createBundle,
  preflight: preflightMacOsVfkitIntegration,
  stopTestResources: stopVfkitTestResources,
  removeTestState: removeVfkitTestState,
};

export function createBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<VfkitNetworkAttachment> {
  return {
    network: new MacOsVfkitNetworkProvider(config, log),
    vm: new VfkitVmProvider(config, log),
  };
}

export function vfkitStatePath(repoDir: string, name: string, instance = TEST_INSTANCE): string {
  return join(repoDir, ".rootcell", "instances", instance, "vfkit", name, "state.json");
}

export function vfkitPrivateLinkStatePath(repoDir: string, instance = TEST_INSTANCE): string {
  return join(repoDir, ".rootcell", "instances", instance, "vfkit", "network", "private-link.json");
}

export function lifecycleInstanceDir(repoDir: string): string {
  return join(repoDir, ".rootcell", "instances", LIFECYCLE_INSTANCE);
}

export function readJson(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return JsonObjectSchema.parse(raw);
}

export function pidFromState(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  const pid = readJson(path).pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) ? pid : null;
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = runCapture("ps", ["-o", "stat=", "-p", String(pid)], { allowFailure: true }).stdout.trim();
  return stat.length === 0 || !stat.startsWith("Z");
}

export async function stopPidFromState(path: string): Promise<void> {
  const pid = pidFromState(path);
  if (pid === null || !processIsRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, "TERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processIsRunning(pid)) {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "KILL");
  } catch {
    // The process exited between polls.
  }
}

export async function stopVfkitTestResources(repoDir: string): Promise<void> {
  await stopPidFromState(vfkitStatePath(repoDir, AGENT_VM_NAME));
  await stopPidFromState(vfkitStatePath(repoDir, FIREWALL_VM_NAME));
  await stopPidFromState(vfkitPrivateLinkStatePath(repoDir));
  await stopLifecycleProcesses(repoDir);
}

export async function removeVfkitTestState(repoDir: string): Promise<void> {
  await stopVfkitTestResources(repoDir);
  rmSync(join(repoDir, ".rootcell", "instances", TEST_INSTANCE), {
    recursive: true,
    force: true,
  });
  rmSync(lifecycleInstanceDir(repoDir), {
    recursive: true,
    force: true,
  });
}

export async function stopLifecycleProcesses(repoDir: string): Promise<void> {
  for (const path of [
    vfkitStatePath(repoDir, `agent-${LIFECYCLE_INSTANCE}`, LIFECYCLE_INSTANCE),
    vfkitStatePath(repoDir, `firewall-${LIFECYCLE_INSTANCE}`, LIFECYCLE_INSTANCE),
    vfkitPrivateLinkStatePath(repoDir, LIFECYCLE_INSTANCE),
  ]) {
    await stopPidFromState(path);
  }
}

export async function prepareLifecycleInstance(repoDir: string): Promise<void> {
  await stopLifecycleProcesses(repoDir);
  rmSync(lifecycleInstanceDir(repoDir), { recursive: true, force: true });
  mkdirSync(lifecycleInstanceDir(repoDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(lifecycleInstanceDir(repoDir), "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    subnet: "192.168.110.0",
    networkPrefix: 24,
    firewallIp: "192.168.110.2",
    agentIp: "192.168.110.3",
  }, null, 2)}\n`, "utf8");
  writeStoppedLifecycleVmState(repoDir, `agent-${LIFECYCLE_INSTANCE}`);
  writeStoppedLifecycleVmState(repoDir, `firewall-${LIFECYCLE_INSTANCE}`);
  mkdirSync(join(lifecycleInstanceDir(repoDir), "vfkit", "network"), { recursive: true, mode: 0o700 });
}

function writeStoppedLifecycleVmState(repoDir: string, name: string): void {
  const dir = join(lifecycleInstanceDir(repoDir), "vfkit", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "disk.raw"), "");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}
