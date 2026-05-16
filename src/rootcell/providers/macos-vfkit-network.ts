import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveHostTool } from "../host-tools.ts";
import { runCapture } from "../process.ts";
import { NonEmptyStringSchema, PositiveSafeIntegerSchema } from "../schema.ts";
import type { RootcellConfig } from "../types.ts";
import type { NetworkPlan, NetworkProvider, VmNetworkAttachment } from "./types.ts";

export interface VfkitNetworkAttachment extends VmNetworkAttachment {
  readonly kind: "vfkit";
  readonly role: "agent" | "firewall";
  readonly privateMac: string;
  readonly privateSocketPath: string;
  readonly controlMac?: string;
  readonly useNat: boolean;
}

const PrivateLinkStateSchema = z.object({
  pid: PositiveSafeIntegerSchema,
  firewallSocketPath: NonEmptyStringSchema,
  agentSocketPath: NonEmptyStringSchema,
});

type PrivateLinkState = Readonly<z.infer<typeof PrivateLinkStateSchema>>;

export class MacOsVfkitNetworkProvider implements NetworkProvider<VfkitNetworkAttachment> {
  readonly id = "macos-vfkit";

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {}

  private pythonBin = "";

  plan(): NetworkPlan<VfkitNetworkAttachment> {
    return {
      provider: this.id,
      guest: {
        firewallIp: this.config.firewallIp,
        agentIp: this.config.agentIp,
        networkPrefix: 24,
        agentPrivateInterface: "enp0s1",
        firewallPrivateInterface: "enp0s2",
        firewallEgressInterface: "enp0s1",
        firewallControlInterface: "enp0s1",
      },
      vms: {
        agent: {
          kind: "vfkit",
          role: "agent",
          privateMac: getMacAddressFor(this.config, "agent", "private"),
          privateSocketPath: this.agentSocketPath(),
          useNat: false,
        },
        firewall: {
          kind: "vfkit",
          role: "firewall",
          controlMac: getMacAddressFor(this.config, "firewall", "control"),
          privateMac: getMacAddressFor(this.config, "firewall", "private"),
          privateSocketPath: this.firewallSocketPath(),
          useNat: true,
        },
      },
    };
  }

  preflight(): Promise<void> {
    this.ensurePython();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    const state = this.readState();
    if (state === null || !processIsRunning(state.pid)) {
      return;
    }
    this.log(`stopping vfkit private link for instance '${this.config.instanceName}'...`);
    await terminateProcess(state.pid);
  }

  async remove(): Promise<void> {
    await this.stop();
    rmSync(this.networkDir(), { recursive: true, force: true });
  }

  async ensureReady(input: {
    readonly affectedVms: readonly string[];
    readonly stopVmIfRunning: (name: string) => Promise<void>;
  }): Promise<void> {
    if (this.privateLinkRunning()) {
      return;
    }
    for (const vm of input.affectedVms) {
      await input.stopVmIfRunning(vm);
    }
    await this.startPrivateLink();
  }

  private async startPrivateLink(): Promise<void> {
    mkdirSync(this.networkDir(), { recursive: true, mode: 0o700 });
    rmSync(this.firewallSocketPath(), { force: true });
    rmSync(this.agentSocketPath(), { force: true });
    const helper = join(this.config.repoDir, "src/bin/rootcell-vfkit-l2-helper.py");
    this.log(`starting hostless vfkit private link for instance '${this.config.instanceName}'...`);
    const child = spawn(this.ensurePython(), [
      helper,
      this.firewallSocketPath(),
      this.agentSocketPath(),
    ], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) {
      throw new Error("rootcell vfkit L2 helper did not report a pid");
    }
    child.unref();
    writeFileSync(this.statePath(), `${JSON.stringify({
      pid: child.pid,
      firewallSocketPath: this.firewallSocketPath(),
      agentSocketPath: this.agentSocketPath(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.waitForPrivateLinkReady(child.pid);
  }

  private async waitForPrivateLinkReady(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(this.firewallSocketPath()) && existsSync(this.agentSocketPath())) {
        return;
      }
      if (!processIsRunning(pid)) {
        throw new Error("rootcell vfkit L2 helper exited before creating sockets");
      }
      await sleep(50);
    }
    await terminateProcess(pid);
    throw new Error("timeout waiting for rootcell vfkit L2 helper sockets");
  }

  private privateLinkRunning(): boolean {
    const state = this.readState();
    if (state === null) {
      return false;
    }
    try {
      process.kill(state.pid, 0);
    } catch {
      return false;
    }
    return existsSync(state.firewallSocketPath) && existsSync(state.agentSocketPath);
  }

  private readState(): PrivateLinkState | null {
    if (!existsSync(this.statePath())) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.statePath(), "utf8"));
      return PrivateLinkStateSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private networkDir(): string {
    return join(this.config.instanceDir, "vfkit", "network");
  }

  private statePath(): string {
    return join(this.networkDir(), "private-link.json");
  }

  private firewallSocketPath(): string {
    return join(this.networkDir(), "firewall-private.sock");
  }

  private agentSocketPath(): string {
    return join(this.networkDir(), "agent-private.sock");
  }

  private ensurePython(): string {
    if (this.pythonBin.length === 0) {
      this.pythonBin = resolveHostTool({
        name: "python3",
        envVar: "ROOTCELL_PYTHON",
        purpose: "for the rootcell vfkit private-link helper",
      });
    }
    return this.pythonBin;
  }
}

export function getMacAddressFor(config: RootcellConfig, role: string, name: string): string {
  const digest = createHash("sha256")
    .update(`${config.repoDir}:${config.instanceName}:${role}:${name}`)
    .digest();
  return [
    0x52,
    0x54,
    0x00,
    digest[0] ?? 0,
    digest[1] ?? 0,
    digest[2] ?? 0,
  ].map((octet) => octet.toString(16).padStart(2, "0")).join(":");
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = runCapture("ps", ["-o", "stat=", "-p", String(pid)], { allowFailure: true }).stdout.trim();
  return stat.length === 0 || !stat.startsWith("Z");
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, 100, 100)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The helper may have exited between the last poll and SIGKILL.
    return;
  }
  if (!await waitForProcessExit(pid, 50, 100)) {
    throw new Error(`process ${String(pid)} did not exit after SIGKILL`);
  }
}

async function waitForProcessExit(pid: number, attempts: number, intervalMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processIsRunning(pid)) {
      return true;
    }
    await sleep(intervalMs);
  }
  return !processIsRunning(pid);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}
