import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveHostTool } from "../host-tools.ts";
import { ImageStore } from "../images.ts";
import { runCapture, runInherited } from "../process.ts";
import { NonEmptyStringSchema, parseSchema, PositiveSafeIntegerSchema } from "../schema.ts";
import type { RootcellConfig } from "../types.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { CopyToGuestOptions, ExecOptions, VmProvider, VmRole, VmStatus } from "./types.ts";
import type { VfkitNetworkAttachment } from "./macos-vfkit-network.ts";
import { ProxyJumpSshTransport, type ProxyJumpSshEndpoints } from "../transports/proxyjump-ssh.ts";

const VfkitProviderSchema = z.custom<"vfkit">((value) => value === "vfkit", { message: "provider mismatch" });
const VfkitVmRoleSchema = z.custom<VmRole>(
  (value) => value === "agent" || value === "firewall",
  { message: "role mismatch" },
);

const VfkitVmStateSchema = z.object({
  provider: VfkitProviderSchema,
  name: NonEmptyStringSchema,
  role: VfkitVmRoleSchema,
  pid: PositiveSafeIntegerSchema,
  diskPath: NonEmptyStringSchema,
  efiVariableStorePath: NonEmptyStringSchema,
  restSocketPath: NonEmptyStringSchema,
  logPath: NonEmptyStringSchema,
  privateMac: NonEmptyStringSchema,
  controlMac: NonEmptyStringSchema.optional(),
  firewallControlIp: NonEmptyStringSchema.optional(),
});

type VfkitVmState = Readonly<z.infer<typeof VfkitVmStateSchema>>;

export class VfkitVmProvider implements VmProvider<VfkitNetworkAttachment> {
  readonly id = "vfkit";
  private vfkitBin = "";
  private readonly imageStore: ImageStore;
  private readonly transport: ProxyJumpSshTransport;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {
    this.imageStore = new ImageStore(config, log);
    this.transport = new ProxyJumpSshTransport(config, () => this.transportEndpoints());
  }

  status(name: string): Promise<VmStatus> {
    const state = this.readVmState(name);
    if (state !== null && processIsRunning(state.pid)) {
      return Promise.resolve({ state: "running" });
    }
    if (existsSync(this.diskPath(name))) {
      return Promise.resolve({ state: "stopped" });
    }
    return Promise.resolve({ state: "missing" });
  }

  forceStopIfRunning(name: string): Promise<void> {
    const state = this.readVmState(name);
    if (state === null || !processIsRunning(state.pid)) {
      return Promise.resolve();
    }
    this.log(`stopping ${name} vfkit VM...`);
    try {
      process.kill(state.pid, "TERM");
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  assertCompatible(name: string, network: VfkitNetworkAttachment): Promise<void> {
    const state = this.readVmState(name);
    if (state === null) {
      return Promise.resolve();
    }
    if (state.privateMac !== network.privateMac || state.controlMac !== network.controlMac) {
      throw new Error(`${name} exists with incompatible vfkit network attachments; delete and recreate it`);
    }
    return Promise.resolve();
  }

  async ensureRunning(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: VfkitNetworkAttachment;
  }): Promise<{ readonly created: boolean }> {
    const status = await this.status(input.name);
    switch (status.state) {
      case "running":
        await this.waitForSsh(input.name);
        return { created: false };
      case "stopped":
        this.log(`starting ${input.name} vfkit VM...`);
        this.startVm(input);
        await this.waitForSsh(input.name);
        return { created: false };
      case "missing":
        this.log(`${input.name} vfkit VM not found; creating from rootcell image...`);
        this.prepareDisk(input.role, input.name);
        this.startVm(input);
        await this.waitForSsh(input.name);
        return { created: true };
      case "unexpected":
        throw new Error(`${input.name} VM in unexpected state: ${status.detail}`);
    }
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    return this.transport.exec(name, command, options);
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    return this.transport.execCapture(name, command, options);
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await this.transport.execInteractive(name, command, options);
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    return this.transport.copyToGuest(name, hostPath, guestPath, options);
  }

  forgetSshHostKey(name: string): Promise<void> {
    this.transport.forgetHostKey(name);
    return Promise.resolve();
  }

  private startVm(input: { readonly role: VmRole; readonly name: string; readonly network: VfkitNetworkAttachment }): void {
    this.ensureVfkit();
    this.ensureControlKey();
    mkdirSync(this.vmDir(input.name), { recursive: true, mode: 0o700 });
    const args = vfkitArgs({
      role: input.role,
      diskPath: this.diskPath(input.name),
      efiVariableStorePath: this.efiVariableStorePath(input.name),
      restSocketPath: this.restSocketPath(input.name),
      logPath: this.logPath(input.name),
      cloudInitDir: this.writeCloudInit(input.role, input.name, input.network),
      network: input.network,
    });
    rmSync(this.restSocketPath(input.name), { force: true });
    const child = spawn(this.vfkitBin, args, {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) {
      throw new Error("vfkit did not report a pid");
    }
    child.unref();
    const state: VfkitVmState = {
      provider: "vfkit",
      name: input.name,
      role: input.role,
      pid: child.pid,
      diskPath: this.diskPath(input.name),
      efiVariableStorePath: this.efiVariableStorePath(input.name),
      restSocketPath: this.restSocketPath(input.name),
      logPath: this.logPath(input.name),
      privateMac: input.network.privateMac,
      ...(input.network.controlMac === undefined ? {} : { controlMac: input.network.controlMac }),
      ...(input.role === "firewall" ? { firewallControlIp: this.waitForFirewallControlIp(input.network) } : {}),
    };
    this.writeVmState(input.name, state);
  }

  private prepareDisk(role: VmRole, name: string): void {
    mkdirSync(this.vmDir(name), { recursive: true, mode: 0o700 });
    const base = this.imageStore.ensureRoleImage(role);
    const disk = this.diskPath(name);
    if (existsSync(disk)) {
      return;
    }
    const clone = runInherited("cp", ["-c", base, disk], { allowFailure: true, ignoredOutput: true });
    if (clone.status !== 0) {
      runInherited("cp", [base, disk]);
    }
    runInherited("truncate", ["-s", role === "agent" ? "60G" : "16G", disk]);
  }

  private ensureVfkit(): void {
    if (this.vfkitBin.length > 0) {
      return;
    }
    this.vfkitBin = resolveHostTool({
      name: "vfkit",
      envVar: "ROOTCELL_VFKIT",
      purpose: "to start rootcell VMs on macOS",
    });
  }

  private ensureControlKey(): void {
    const key = this.identityPath();
    if (existsSync(key) && existsSync(`${key}.pub`)) {
      return;
    }
    mkdirSync(join(this.config.instanceDir, "ssh"), { recursive: true, mode: 0o700 });
    runInherited("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `rootcell-${this.config.instanceName}`, "-f", key]);
  }

  private writeCloudInit(role: VmRole, name: string, network: VfkitNetworkAttachment): string {
    const dir = join(this.vmDir(name), "cloud-init");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const publicKey = readFileSync(`${this.identityPath()}.pub`, "utf8").trim();
    writeFileSync(join(dir, "meta-data"), [
      `instance-id: rootcell-${this.config.instanceName}-${role}`,
      `local-hostname: ${role === "agent" ? "agent-vm" : "firewall-vm"}`,
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "user-data"), vfkitCloudInitUserData({
      role,
      user: this.config.guestUser,
      publicKey,
      instanceName: this.config.instanceName,
      firewallIp: this.config.firewallIp,
      agentIp: this.config.agentIp,
      networkPrefix: this.config.networkPrefix,
      privateMac: network.privateMac,
    }), "utf8");
    return dir;
  }

  private async waitForSsh(name: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await this.transport.exec(name, ["true"], {
        allowFailure: true,
        ignoredOutput: true,
      });
      if (result.status === 0) {
        return;
      }
      await Bun.sleep(500);
    }
    throw new Error(`timeout waiting for SSH transport to ${name}`);
  }

  private waitForFirewallControlIp(network: VfkitNetworkAttachment): string {
    if (network.controlMac === undefined) {
      throw new Error("firewall vfkit VM is missing a control MAC");
    }
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const leaseIp = lookupDhcpLease(network.controlMac, undefined, "firewall-vm");
      if (leaseIp !== null && arpHasIpForMac(leaseIp, network.controlMac)) {
        return leaseIp;
      }
      const arpIp = lookupArpIpByMac(network.controlMac);
      if (arpIp !== null) {
        return arpIp;
      }
      Bun.sleepSync(500);
    }
    throw new Error(`timeout waiting for DHCP lease for firewall control MAC ${network.controlMac}`);
  }

  private transportEndpoints(): ProxyJumpSshEndpoints {
    const firewall = this.readVmState(this.config.firewallVm);
    if (firewall?.firewallControlIp === undefined) {
      throw new Error("firewall control IP is not known yet");
    }
    return {
      firewallHost: firewall.firewallControlIp,
      agentHost: this.config.agentIp,
      identityPath: this.identityPath(),
      knownHostsPath: this.knownHostsPath(),
    };
  }

  private readVmState(name: string): VfkitVmState | null {
    const path = this.statePath(name);
    if (!existsSync(path)) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      return parseVfkitVmState(raw);
    } catch {
      return null;
    }
  }

  private writeVmState(name: string, state: VfkitVmState): void {
    writeFileSync(this.statePath(name), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private vmDir(name: string): string {
    return join(this.config.instanceDir, "vfkit", name);
  }

  private statePath(name: string): string {
    return join(this.vmDir(name), "state.json");
  }

  private diskPath(name: string): string {
    return join(this.vmDir(name), "disk.raw");
  }

  private efiVariableStorePath(name: string): string {
    return join(this.vmDir(name), "efi-variable-store");
  }

  private restSocketPath(name: string): string {
    return join(this.vmDir(name), "rest.sock");
  }

  private logPath(name: string): string {
    return join(this.vmDir(name), "serial.log");
  }

  private identityPath(): string {
    return join(this.config.instanceDir, "ssh", "rootcell_control_ed25519");
  }

  private knownHostsPath(): string {
    return join(this.config.instanceDir, "ssh", "known_hosts");
  }
}

export function vfkitCloudInitUserData(input: {
  readonly role: VmRole;
  readonly user: string;
  readonly publicKey: string;
  readonly instanceName: string;
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly networkPrefix: string;
  readonly privateMac: string;
}): string {
  const address = input.role === "agent" ? input.agentIp : input.firewallIp;
  const networkdConfig = [
    "[Match]",
    `MACAddress=${input.privateMac}`,
    "",
    "[Network]",
    "DHCP=no",
    "IPv6AcceptRA=false",
    "LinkLocalAddressing=no",
    `Address=${address}/${input.networkPrefix}`,
    ...(input.role === "agent" ? [`DNS=${input.firewallIp}`, "", "[Route]", `Gateway=${input.firewallIp}`] : []),
  ];
  const networkScript = input.role === "agent"
    ? [
      `private_mac='${input.privateMac}'`,
      "iface=''",
      "for path in /sys/class/net/*; do",
      "  candidate=\"${path##*/}\"",
      "  if [ \"$candidate\" != lo ] && [ \"$(cat \"$path/address\" 2>/dev/null)\" = \"$private_mac\" ]; then",
      "    iface=\"$candidate\"",
      "    break",
      "  fi",
      "done",
      "test -n \"$iface\"",
      `addr='${input.agentIp}/${input.networkPrefix}'`,
      `gateway='${input.firewallIp}'`,
      "ip link set \"$iface\" up",
      "ip addr flush dev \"$iface\"",
      "ip addr add \"$addr\" dev \"$iface\"",
      "ip route replace default via \"$gateway\" dev \"$iface\"",
      "if command -v resolvectl >/dev/null 2>&1; then",
      "  resolvectl dns \"$iface\" \"$gateway\" || true",
      "  resolvectl domain \"$iface\" '~.' || true",
      "fi",
      "printf 'nameserver %s\\n' \"$gateway\" > /etc/resolv.conf",
    ]
    : [
      `private_mac='${input.privateMac}'`,
      "iface=''",
      "for path in /sys/class/net/*; do",
      "  candidate=\"${path##*/}\"",
      "  if [ \"$candidate\" != lo ] && [ \"$(cat \"$path/address\" 2>/dev/null)\" = \"$private_mac\" ]; then",
      "    iface=\"$candidate\"",
      "    break",
      "  fi",
      "done",
      "test -n \"$iface\"",
      `addr='${input.firewallIp}/${input.networkPrefix}'`,
      "ip link set \"$iface\" up",
      "ip addr flush dev \"$iface\"",
      "ip addr add \"$addr\" dev \"$iface\"",
    ];

  return [
    "#cloud-config",
    "network:",
    "  config: disabled",
    "ssh_pwauth: false",
    "disable_root: true",
    "users:",
    `  - name: ${input.user}`,
    "    groups: [wheel, users]",
    "    shell: /run/current-system/sw/bin/bash",
    "    lock_passwd: false",
    "    hashed_passwd: '$6$oNa2PyJnJvk0BPB0$V33WZJn774wIiCOV.s1pTybr31f.VGEGSOp2aPbQQ3GQpk6mHfF99NOMFv5CLU.CZqYLhlcUhaW72zAhDW/BG1'",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    ssh_authorized_keys:",
    `      - ${input.publicKey}`,
    "write_files:",
    "  - path: /etc/rootcell-instance.json",
    "    permissions: '0644'",
    "    content: |",
    `      {"instance":"${input.instanceName}","role":"${input.role}","firewallIp":"${input.firewallIp}","agentIp":"${input.agentIp}"}`,
    "runcmd:",
    "  - |",
    "      set -eu",
    "      rm -f /etc/systemd/network/10-cloud-init-*.network",
    "      install -d -m 0755 /etc/systemd/network",
    "      cat > /etc/systemd/network/05-rootcell-private.network <<'EOF'",
    ...networkdConfig.map((line) => `      ${line}`),
    "      EOF",
    "      systemctl restart systemd-networkd || true",
    ...networkScript.map((line) => `      ${line}`),
    "",
  ].join("\n");
}

export function vfkitArgs(input: {
  readonly role: VmRole;
  readonly diskPath: string;
  readonly efiVariableStorePath: string;
  readonly restSocketPath: string;
  readonly logPath: string;
  readonly cloudInitDir: string;
  readonly network: VfkitNetworkAttachment;
}): readonly string[] {
  const memory = input.role === "agent" ? "16384" : "4096";
  const cpus = input.role === "agent" ? "8" : "2";
  return [
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--bootloader",
    `efi,variable-store=${input.efiVariableStorePath},create`,
    "--restful-uri",
    `unix://${input.restSocketPath}`,
    "--device",
    `virtio-blk,path=${input.diskPath}`,
    "--device",
    `virtio-serial,logFilePath=${input.logPath}`,
    "--device",
    "virtio-rng",
    "--device",
    "virtio-balloon",
    ...(input.network.useNat && input.network.controlMac !== undefined
      ? ["--device", `virtio-net,nat,mac=${input.network.controlMac}`]
      : []),
    "--device",
    `virtio-net,unixSocketPath=${input.network.privateSocketPath},mac=${input.network.privateMac}`,
    "--cloud-init",
    `${join(input.cloudInitDir, "user-data")},${join(input.cloudInitDir, "meta-data")}`,
  ];
}

export function parseVfkitVmState(raw: unknown): VfkitVmState {
  return parseSchema(VfkitVmStateSchema, raw, "invalid vfkit VM state");
}

export function lookupDhcpLease(mac: string, leasesPath = "/var/db/dhcpd_leases", fallbackName?: string): string | null {
  if (!existsSync(leasesPath)) {
    return null;
  }
  const normalized = mac.toLowerCase();
  const blocks = readFileSync(leasesPath, "utf8").split(/\n\s*\n/);
  let fallback: { readonly ip: string; readonly lease: number } | null = null;
  for (const block of blocks) {
    const match = /ip_address\s*=\s*([0-9.]+)/.exec(block);
    if (block.toLowerCase().includes(normalized) && match?.[1] !== undefined) {
      return match[1];
    }
    if (fallbackName !== undefined && match?.[1] !== undefined && dhcpName(block) === fallbackName) {
      const lease = dhcpLease(block);
      if (fallback === null || lease > fallback.lease) {
        fallback = { ip: match[1], lease };
      }
    }
  }
  return fallback?.ip ?? null;
}

function lookupArpIpByMac(mac: string): string | null {
  const normalized = normalizeMac(mac);
  const output = runCapture("arp", ["-an"], { allowFailure: true }).stdout;
  for (const line of output.split(/\r?\n/)) {
    const match = /\(([0-9.]+)\)\s+at\s+([0-9a-f:]+)/i.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || normalizeMac(match[2]) !== normalized) {
      continue;
    }
    return match[1];
  }
  return null;
}

function arpHasIpForMac(ip: string, mac: string): boolean {
  const normalized = normalizeMac(mac);
  const output = runCapture("arp", ["-an"], { allowFailure: true }).stdout;
  return output.split(/\r?\n/).some((line) => {
    const match = /\(([0-9.]+)\)\s+at\s+([0-9a-f:]+)/i.exec(line);
    return match?.[1] === ip && match[2] !== undefined && normalizeMac(match[2]) === normalized;
  });
}

function normalizeMac(mac: string): string {
  return mac.toLowerCase().split(":").map((part) => part.replace(/^0([0-9a-f])$/, "$1")).join(":");
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dhcpName(block: string): string | null {
  const match = /(?:^|\n)\s*name\s*=\s*([^\n]+)/.exec(block);
  return match?.[1]?.trim() ?? null;
}

function dhcpLease(block: string): number {
  const match = /(?:^|\n)\s*lease\s*=\s*0x([0-9a-f]+)/i.exec(block);
  if (match?.[1] === undefined) {
    return 0;
  }
  return Number.parseInt(match[1], 16);
}
