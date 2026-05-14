import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCapture, runInherited } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
import type { NetworkPlan, NetworkProvider, VmNetworkAttachment } from "./types.ts";

const SOCKET_VMNET_DST = "/opt/socket_vmnet/bin/socket_vmnet";
const ROOTCELL_VMNET_HELPER_DST = "/opt/rootcell/bin/rootcell-vmnet";
const ROOTCELL_VMNET_SUDOERS = "/private/etc/sudoers.d/rootcell-vmnet";

export interface LimaSocketNetworkAttachment extends VmNetworkAttachment {
  readonly kind: "lima-socket";
  readonly socketPath: string;
  readonly sshOverVsock: true;
  readonly disableDefaultUsernet: boolean;
  readonly useDefaultNat: boolean;
}

export class MacOsSocketVmnetNetworkProvider implements NetworkProvider<LimaSocketNetworkAttachment> {
  readonly id = "macos-socket-vmnet";

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {}

  plan(): NetworkPlan<LimaSocketNetworkAttachment> {
    return {
      provider: this.id,
      guest: {
        firewallIp: this.config.firewallIp,
        agentIp: this.config.agentIp,
        networkPrefix: 24,
        agentPrivateInterface: "enp0s1",
        firewallPrivateInterface: "enp0s2",
        firewallEgressInterface: "enp0s1",
      },
      vms: {
        agent: {
          kind: "lima-socket",
          socketPath: this.config.vmnetSocketPath,
          sshOverVsock: true,
          disableDefaultUsernet: true,
          useDefaultNat: false,
        },
        firewall: {
          kind: "lima-socket",
          socketPath: this.config.vmnetSocketPath,
          sshOverVsock: true,
          disableDefaultUsernet: false,
          useDefaultNat: true,
        },
      },
    };
  }

  preflight(): Promise<void> {
    this.ensureSocketVmnet();
    this.ensureRootcellVmnetHelper();
    return Promise.resolve();
  }

  async ensureReady(input: {
    readonly affectedVms: readonly string[];
    readonly stopVmIfRunning: (name: string) => Promise<void>;
  }): Promise<void> {
    const status = runCapture("sudo", [
      "-n",
      ROOTCELL_VMNET_HELPER_DST,
      "status",
      this.config.instanceName,
    ], { allowFailure: true });
    if (status.status === 0) {
      return;
    }
    if (status.status !== 1 || status.stderr.length > 0) {
      process.stderr.write(status.stderr);
      this.log("failed to check rootcell vmnet helper status.");
      process.exit(1);
    }
    this.log(`starting isolated vmnet daemon for instance '${this.config.instanceName}' (${this.config.firewallIp}/24, ${this.config.agentIp}/24)...`);
    for (const vm of input.affectedVms) {
      await input.stopVmIfRunning(vm);
    }
    const start = runInherited("sudo", [
      "-n",
      ROOTCELL_VMNET_HELPER_DST,
      "start",
      this.config.instanceName,
      this.config.vmnetUuid,
    ], { allowFailure: true });
    if (start.status !== 0) {
      this.log("failed to start rootcell vmnet helper.");
      process.exit(1);
    }
  }

  private ensureSocketVmnet(): void {
    const result = runCapture("nix", [
      "build",
      "--no-link",
      "--print-out-paths",
      `${this.config.repoDir}#socket_vmnet`,
    ], { allowFailure: true });
    if (result.status !== 0) {
      this.log(`failed to build socket_vmnet from ${this.config.repoDir}/pkgs/socket_vmnet.nix:`);
      process.stderr.write(result.stderr);
      process.exit(1);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    const out = firstToken(result.stdout);
    const nixBin = join(out, "bin/socket_vmnet");
    if (existsSync(SOCKET_VMNET_DST)) {
      const cmp = runInherited("cmp", ["-s", nixBin, SOCKET_VMNET_DST], {
        allowFailure: true,
        ignoredOutput: true,
      });
      if (cmp.status === 0) {
        return;
      }
    }

    process.stderr.write(`rootcell: socket_vmnet not installed (or out of date) at /opt/socket_vmnet.

Why this needs sudo: macOS vmnet.framework requires socket_vmnet to run as
root. rootcell's one-time helper grant references the binary by this stable
root-owned path, while the binary itself is built declaratively from this
repo's flake (see pkgs/socket_vmnet.nix).

Run:

  sudo install -m 0755 -d /opt/socket_vmnet/bin
  sudo install -m 0755 \\
    ${out}/bin/socket_vmnet \\
    ${out}/bin/socket_vmnet_client \\
    /opt/socket_vmnet/bin/

Then re-run ./rootcell.
`);
    process.exit(1);
  }

  private ensureRootcellVmnetHelper(): void {
    const helperSrc = join(this.config.repoDir, "src/bin/rootcell-vmnet-helper.sh");
    const helperOk = existsSync(ROOTCELL_VMNET_HELPER_DST)
      && runInherited("cmp", ["-s", helperSrc, ROOTCELL_VMNET_HELPER_DST], {
        allowFailure: true,
        ignoredOutput: true,
      }).status === 0;
    const sudoersOk = this.rootcellVmnetSudoersLooksInstalled();
    if (helperOk && sudoersOk) {
      return;
    }
    process.stderr.write(`rootcell: one-time rootcell vmnet helper setup needed.

The new per-instance networks use a small root-owned helper with one stable
sudoers rule. This avoids editing Lima managed networks or regenerating Lima
sudoers for every instance.

Run:

  sudo install -m 0755 -d /opt/rootcell/bin
  sudo install -m 0755 \\
    ${shellQuote(helperSrc)} \\
    ${shellQuote(ROOTCELL_VMNET_HELPER_DST)}
  sudo chown root:wheel ${shellQuote(ROOTCELL_VMNET_HELPER_DST)}
  printf '%s\\n' '%staff ALL=(root:wheel) NOPASSWD:NOSETENV: ${ROOTCELL_VMNET_HELPER_DST} *' \\
    | sudo tee ${ROOTCELL_VMNET_SUDOERS} >/dev/null
  sudo chmod 0440 ${ROOTCELL_VMNET_SUDOERS}

Then re-run ./rootcell.
`);
    process.exit(1);
  }

  private rootcellVmnetSudoersLooksInstalled(): boolean {
    if (!existsSync(ROOTCELL_VMNET_SUDOERS)) {
      return false;
    }
    try {
      return readFileSync(ROOTCELL_VMNET_SUDOERS, "utf8").includes(ROOTCELL_VMNET_HELPER_DST);
    } catch {
      return true;
    }
  }
}

function firstToken(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) {
    throw new Error("command produced no output");
  }
  return token;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
