import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseRootcellArgs } from "./args.ts";
import { loadDotEnv, nixString, parseSecretMappings } from "./env.ts";
import { DEFAULT_IMAGE_MANIFEST_URL } from "./images.ts";
import {
  deriveVmNames,
  listRootcellVmInstanceNames,
  loadExistingRootcellInstance,
  loadRootcellInstance,
  seedRootcellInstanceFiles,
} from "./instance.ts";
import { commandExists, runCapture, runInherited } from "./process.ts";
import { createProviderBundle } from "./providers/factory.ts";
import type { NetworkPlan, ProviderBundle, VmNetworkAttachment, VmStatus } from "./providers/types.ts";
import { parseSchema } from "./schema.ts";
import { RootcellConfigSchema, type RootcellConfig, type RootcellInstance, type SpyOptions, type VmFileSet } from "./types.ts";

const GUEST_USER = "luser";

const VM_FILES: VmFileSet = {
  agent: [
    "flake.nix",
    "flake.lock",
    "common.nix",
    "agent-vm.nix",
    "home.nix",
    "network.nix",
    "pi",
  ],
  firewall: [
    "flake.nix",
    "flake.lock",
    "common.nix",
    "firewall-vm.nix",
    "network.nix",
    "proxy",
    "src/bin/reload.ts",
  ],
};

export interface VmListEntry {
  readonly instance: string;
  readonly vm: string;
  readonly state: string;
}

function log(message: string): void {
  console.error(`rootcell: ${message}`);
}

export function formatVmList(entries: readonly VmListEntry[]): string {
  if (entries.length === 0) {
    return "No rootcell VMs found.\n";
  }
  const rows = [
    ["INSTANCE", "VM", "STATE"],
    ...entries.map((entry) => [entry.instance, entry.vm, entry.state]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return `${rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n")}\n`;
}

function statusText(status: VmStatus): string {
  return status.state === "unexpected" ? `unexpected: ${status.detail}` : status.state;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function repoDirFromImportMeta(importMetaPath: string): string {
  let dir = dirname(resolve(importMetaPath));
  for (;;) {
    if (existsSync(join(dir, "flake.nix")) && existsSync(join(dir, "completions"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(dirname(importMetaPath), "../..");
    }
    dir = parent;
  }
}

export function buildConfig(repoDir: string, env: NodeJS.ProcessEnv, instance: RootcellInstance): RootcellConfig {
  const vmNames = deriveVmNames(instance.name);
  return parseSchema(RootcellConfigSchema, {
    repoDir,
    instanceName: instance.name,
    instanceDir: instance.dir,
    envPath: instance.envPath,
    secretsPath: instance.secretsPath,
    proxyDir: instance.proxyDir,
    pkiDir: instance.pkiDir,
    generatedDir: instance.generatedDir,
    agentVm: vmNames.agentVm,
    firewallVm: vmNames.firewallVm,
    guestUser: GUEST_USER,
    guestRepoDir: `/home/${GUEST_USER}/rootcell`,
    firewallIp: instance.state.firewallIp,
    agentIp: instance.state.agentIp,
    networkPrefix: String(instance.state.networkPrefix),
    imageManifestUrl: env.ROOTCELL_IMAGE_MANIFEST_URL ?? DEFAULT_IMAGE_MANIFEST_URL,
    ...(env.ROOTCELL_IMAGE_DIR === undefined || env.ROOTCELL_IMAGE_DIR.length === 0 ? {} : { imageDir: env.ROOTCELL_IMAGE_DIR }),
  }, `invalid rootcell config for ${instance.name}`);
}

export class RootcellApp<TAttachment extends VmNetworkAttachment> {
  private readonly networkPlan: NetworkPlan<TAttachment>;

  constructor(
    private readonly config: RootcellConfig,
    private readonly providers: ProviderBundle<TAttachment>,
  ) {
    this.networkPlan = this.providers.network.plan();
  }

  async runAfterEnvironment(subcommand: string, rest: readonly string[], spyOptions: SpyOptions): Promise<number> {
    if (subcommand === "list") {
      process.stdout.write(formatVmList(await this.listVms()));
      return 0;
    }
    if (subcommand === "stop") {
      await this.stopVms();
      process.stdout.write(`stopped ${this.config.instanceName}\n`);
      return 0;
    }
    if (subcommand === "remove") {
      await this.removeVms();
      process.stdout.write(`stopped ${this.config.instanceName}, deleted state\n`);
      return 0;
    }

    this.writeNetworkLocalNix();

    if (subcommand === "pubkey") {
      return await this.printPubkey();
    }

    await this.providers.network.preflight();
    await this.ensureExistingVmNetworksCompatible();

    if (subcommand === "allow") {
      const status = await this.providers.vm.status(this.config.firewallVm);
      if (status.state !== "running") {
        log("firewall VM not running; start it with ./rootcell first.");
        return 1;
      }
      await this.syncAllowlists();
      log("allowlists reloaded.");
      return 0;
    }

    await this.providers.network.ensureReady({
      affectedVms: [this.config.agentVm, this.config.firewallVm],
      stopVmIfRunning: async (name) => {
        await this.providers.vm.forceStopIfRunning(name);
      },
    });
    await this.ensureFirewall(subcommand === "provision");
    this.ensureCa();
    await this.syncAllowlists();
    await this.waitForFirewallListeners();

    if (subcommand === "spy") {
      return await this.runSpy(spyOptions);
    }

    await this.ensureAgent(subcommand === "provision");
    if (subcommand === "provision") {
      log("done.");
      return 0;
    }

    const injectedSecretEnv = this.readKeychainSecrets();
    const command = rest.length === 0 ? ["bash", "-l"] : [...rest];
    return await this.providers.vm.execInteractive(this.config.agentVm, command, {
      allowFailure: true,
      env: [
        ...injectedSecretEnv,
        `AWS_REGION=${process.env.AWS_REGION ?? "us-east-1"}`,
        "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
      ],
    });
  }

  async listVms(): Promise<readonly VmListEntry[]> {
    return await Promise.all(this.vmEntries().map(async (entry) => ({
      instance: this.config.instanceName,
      vm: entry.name,
      state: statusText(await this.providers.vm.status(entry.name)),
    })));
  }

  async stopVms(): Promise<void> {
    for (const entry of this.vmEntries()) {
      await this.providers.vm.forceStopIfRunning(entry.name);
    }
    await this.waitForVmsStopped();
    await this.providers.network.stop();
  }

  async removeVms(): Promise<void> {
    await this.stopVms();
    for (const entry of this.vmEntries()) {
      await this.providers.vm.remove(entry.name);
    }
    await this.providers.network.remove();
  }

  private vmEntries(): readonly [
    { readonly role: "agent"; readonly name: string },
    { readonly role: "firewall"; readonly name: string },
  ] {
    return [
      { role: "agent", name: this.config.agentVm },
      { role: "firewall", name: this.config.firewallVm },
    ];
  }

  private async waitForVmsStopped(): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const statuses = await Promise.all(this.vmEntries().map(async (entry) => ({
        name: entry.name,
        status: await this.providers.vm.status(entry.name),
      })));
      const running = statuses.filter((entry) => entry.status.state === "running");
      if (running.length === 0) {
        return;
      }
      await sleep(200);
    }
    const statuses = await Promise.all(this.vmEntries().map(async (entry) => ({
      name: entry.name,
      status: statusText(await this.providers.vm.status(entry.name)),
    })));
    throw new Error(`timed out waiting for VMs to stop: ${statuses.map((entry) => `${entry.name}=${entry.status}`).join(", ")}`);
  }

  private writeNetworkLocalNix(): void {
    const network = this.networkPlan.guest;
    const content = [
      "# Generated by ./rootcell from this instance's state. DO NOT EDIT.",
      "{",
      `  firewallIp    = ${nixString(network.firewallIp)};`,
      `  agentIp       = ${nixString(network.agentIp)};`,
      `  networkPrefix = ${String(network.networkPrefix)};`,
      "}",
      "",
    ].join("\n");
    writeFileSync(join(this.config.generatedDir, "network-local.nix"), content, "utf8");
  }

  private async printPubkey(): Promise<number> {
    const status = await this.providers.vm.status(this.config.agentVm);
    if (status.state !== "running") {
      log("agent VM not running; start it with ./rootcell first.");
      return 1;
    }
    const keyPath = `/home/${this.config.guestUser}/.ssh/id_rsa.pub`;
    const keyExists = (await this.providers.vm.exec(this.config.agentVm, ["test", "-f", keyPath], {
      allowFailure: true,
      ignoredOutput: true,
    })).status === 0;
    if (!keyExists) {
      log("no SSH key in agent VM yet; run ./rootcell provision first.");
      return 1;
    }
    return (await this.providers.vm.exec(this.config.agentVm, ["cat", keyPath], { allowFailure: true })).status;
  }

  private async ensureExistingVmNetworksCompatible(): Promise<void> {
    await this.providers.vm.assertCompatible(this.config.firewallVm, this.networkPlan.vms.firewall);
    await this.providers.vm.assertCompatible(this.config.agentVm, this.networkPlan.vms.agent);
  }

  private async bootstrapAgentFirewallRoute(): Promise<void> {
    const network = this.networkPlan.guest;
    const script = `
set -euo pipefail
iface=''
for path in /sys/class/net/*; do
  candidate="\${path##*/}"
  if [ "$candidate" != lo ]; then
    iface="$candidate"
    break
  fi
done
test -n "$iface"
systemctl stop dhcpcd.service 2>/dev/null || true
ip link set "$iface" up
ip addr flush dev "$iface"
ip addr add '${network.agentIp}/${String(network.networkPrefix)}' dev "$iface"
ip route replace default via '${network.firewallIp}' dev "$iface"
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl dns "$iface" '${network.firewallIp}' || true
  resolvectl domain "$iface" '~.' || true
fi
printf 'nameserver %s\\n' '${network.firewallIp}' > /etc/resolv.conf
`;
    await this.providers.vm.exec(this.config.agentVm, ["sudo", "bash", "-lc", script]);
  }

  private async bootstrapAgentFirewallTrust(): Promise<void> {
    const script = `
set -euo pipefail
cert='${this.config.guestRepoDir}/pki/agent-vm-ca-cert.pem'
bundle=/tmp/agent-vm-bootstrap-ca-bundle.crt
if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$cert" > "$bundle"
else
  cp "$cert" "$bundle"
fi
chmod 0644 "$bundle"
`;
    await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", script]);
  }

  private async copyRepoIntoVm(vm: string, files: readonly string[]): Promise<void> {
    await this.providers.vm.exec(vm, ["mkdir", "-p", this.config.guestRepoDir]);
    for (const file of files) {
      const parent = dirname(file);
      const guestParent = parent === "." ? this.config.guestRepoDir : join(this.config.guestRepoDir, parent);
      await this.providers.vm.exec(vm, ["mkdir", "-p", guestParent]);
      await this.providers.vm.copyToGuest(
        vm,
        join(this.config.repoDir, file),
        `${guestParent}/`,
        { recursive: true },
      );
    }
  }

  private async copyHostFileIntoVm(vm: string, hostPath: string, guestPath: string): Promise<void> {
    await this.providers.vm.exec(vm, ["mkdir", "-p", dirname(guestPath)]);
    await this.providers.vm.copyToGuest(vm, hostPath, guestPath);
  }

  private async copyGeneratedNetworkIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "network-local.nix"),
      join(this.config.guestRepoDir, "network-local.nix"),
    );
  }

  private async copyGeneratedGitIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "git-local.nix"),
      join(this.config.guestRepoDir, "git-local.nix"),
    );
  }

  private async copyAgentCaIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.pkiDir, "agent-vm-ca-cert.pem"),
      join(this.config.guestRepoDir, "pki/agent-vm-ca-cert.pem"),
    );
  }

  private writeGitLocalNix(): void {
    const name = runCapture("git", ["config", "--global", "user.name"], { allowFailure: true }).stdout.trim();
    const email = runCapture("git", ["config", "--global", "user.email"], { allowFailure: true }).stdout.trim();
    const lines = ["{"];
    if (name.length > 0) {
      lines.push(`  programs.git.settings.user.name  = ${nixString(name)};`);
    }
    if (email.length > 0) {
      lines.push(`  programs.git.settings.user.email = ${nixString(email)};`);
    }
    lines.push("}", "");
    writeFileSync(join(this.config.generatedDir, "git-local.nix"), lines.join("\n"), "utf8");
  }

  private async waitForFirewallListeners(): Promise<void> {
    const probe = `
for _ in $(seq 1 300); do
  if ss -tlnH | awk "{print \\$4}" | grep -qE ":8080$" \\
     && ss -tlnH | awk "{print \\$4}" | grep -qE ":8081$" \\
     && ss -ulnH | awk "{print \\$4}" | grep -qE ":53$"; then
    exit 0
  fi
  sleep 0.2
done
exit 1
`;
    const ready = (await this.providers.vm.exec(this.config.firewallVm, ["bash", "-c", probe], {
      allowFailure: true,
      ignoredOutput: true,
    })).status === 0;
    if (ready) {
      return;
    }
    log("timeout waiting for firewall services");
    await this.providers.vm.exec(this.config.firewallVm, [
      "journalctl",
      "--no-pager",
      "-n",
      "50",
      "-u",
      "mitmproxy-explicit",
      "-u",
      "mitmproxy-transparent",
      "-u",
      "dnsmasq",
    ], { allowFailure: true });
    process.exit(1);
  }

  private async syncAllowlists(): Promise<void> {
    for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
      await this.providers.vm.copyToGuest(
        this.config.firewallVm,
        join(this.config.proxyDir, file),
        `/etc/agent-vm/${file}`,
      );
    }
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "/etc/agent-vm/reload.sh"]);
  }

  private ensureCa(): void {
    const dir = this.config.pkiDir;
    const key = join(dir, "agent-vm-ca.key");
    const crt = join(dir, "agent-vm-ca-cert.pem");
    const pem = join(dir, "agent-vm-ca.pem");
    if (existsSync(key) && existsSync(crt) && existsSync(pem)) {
      return;
    }

    log(`generating TLS-MITM CA for instance '${this.config.instanceName}' (one-time, persists across runs)`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    runInherited("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      crt,
      "-days",
      "3650",
      "-subj",
      "/CN=agent-vm proxy CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ], { ignoredOutput: true });
    writeFileSync(pem, readFileSync(key, "utf8") + readFileSync(crt, "utf8"), "utf8");
    chmodSync(key, 0o600);
    chmodSync(pem, 0o600);
    chmodSync(crt, 0o644);
  }

  private async syncFirewallCa(): Promise<void> {
    const pem = join(this.config.pkiDir, "agent-vm-ca.pem");
    await this.providers.vm.copyToGuest(this.config.firewallVm, pem, "/tmp/.agent-vm-ca.pem.staged");
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "install",
      "-m",
      "0600",
      "-o",
      "root",
      "-g",
      "root",
      "/tmp/.agent-vm-ca.pem.staged",
      "/etc/agent-vm/agent-vm-ca.pem",
    ]);
    await this.providers.vm.exec(this.config.firewallVm, ["rm", "-f", "/tmp/.agent-vm-ca.pem.staged"]);
  }

  private nixosConfiguration(role: "agent" | "firewall"): string {
    return role === "agent" ? "agent-vm" : "firewall-vm";
  }

  private hostTimeZone(): string {
    if (process.env.TZ !== undefined && process.env.TZ.length > 0) {
      return process.env.TZ;
    }
    try {
      const link = readlinkSync("/etc/localtime");
      for (const prefix of ["/usr/share/zoneinfo/", "/var/db/timezone/zoneinfo/"]) {
        if (link.startsWith(prefix)) {
          return link.slice(prefix.length);
        }
      }
      const marker = "/zoneinfo/";
      const markerAt = link.lastIndexOf(marker);
      if (markerAt >= 0) {
        return link.slice(markerAt + marker.length);
      }
    } catch {
      // Fall through to systemsetup.
    }
    if (commandExists("systemsetup")) {
      return runCapture("systemsetup", ["-gettimezone"], { allowFailure: true }).stdout.replace(/^Time Zone: /, "").trim();
    }
    return "";
  }

  private async runSpy(options: SpyOptions): Promise<number> {
    const spySession = `/run/agent-vm-spy/enabled.${String(process.pid)}`;
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "install", "-d", "-m", "1777", "/run/agent-vm-spy"]);
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "install", "-m", "0666", "/dev/null", "/run/agent-vm-spy/events.ndjson"]);
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "touch", "/run/agent-vm-spy/enabled", spySession]);
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "chmod", "0666", "/run/agent-vm-spy/enabled", spySession]);

    const cleanup = async (): Promise<void> => {
      const script = `
rm -f '${spySession}'
if ls /run/agent-vm-spy/enabled.* >/dev/null 2>&1; then
  touch /run/agent-vm-spy/enabled
  chmod 0666 /run/agent-vm-spy/enabled
else
  rm -f /run/agent-vm-spy/enabled
fi
`;
      await this.providers.vm.exec(this.config.firewallVm, ["sudo", "sh", "-lc", script], {
        allowFailure: true,
        ignoredOutput: true,
      });
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      void cleanup().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    log(`spying on Bedrock Runtime traffic from ${this.config.firewallVm} (Ctrl-C to stop)...`);
    let status: number;
    if (options.tui) {
      const tuiArgs = ["--events", "/run/agent-vm-spy/events.ndjson"];
      const tuiEnv = ["PYTHONUNBUFFERED=1"];
      if (options.raw) {
        tuiArgs.push("--raw");
      }
      if (!options.dedupe) {
        tuiArgs.push("--no-dedupe");
      }
      const zone = this.hostTimeZone();
      if (zone.length > 0) {
        tuiEnv.push(`AGENT_SPY_LOCAL_TZ=${zone}`);
      }
      status = await this.providers.vm.execInteractive(this.config.firewallVm, [
        "sudo",
        "env",
        ...tuiEnv,
        "python3",
        "/etc/agent-vm/agent_spy_tui.py",
        ...tuiArgs,
      ]);
    } else {
      const formatterArgs = ["tail"];
      if (options.raw) {
        formatterArgs.push("--raw");
      }
      if (!options.dedupe) {
        formatterArgs.push("--no-dedupe");
      }
      status = await this.providers.vm.execInteractive(this.config.firewallVm, [
        "sudo",
        "env",
        "PYTHONUNBUFFERED=1",
        "python3",
        "/etc/agent-vm/agent_spy.py",
        ...formatterArgs,
      ]);
    }

    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await cleanup();
    return status;
  }

  private async ensureFirewall(force: boolean): Promise<void> {
    let needsProvision = force;
    if ((await this.providers.vm.ensureRunning({
      role: "firewall",
      name: this.config.firewallVm,
      network: this.networkPlan.vms.firewall,
    })).created) {
      needsProvision = true;
    }
    if (!needsProvision) {
      const check = `
systemctl is-active mitmproxy-explicit >/dev/null 2>&1 \\
 && systemctl is-active mitmproxy-transparent >/dev/null 2>&1 \\
 && systemctl is-active dnsmasq >/dev/null 2>&1 \\
 && test -x /etc/agent-vm/agent_spy.py \\
 && test -x /etc/agent-vm/agent_spy_tui.py \\
 && python3 -c "import textual"
`;
      if ((await this.providers.vm.exec(this.config.firewallVm, ["bash", "-lc", check], {
        allowFailure: true,
        ignoredOutput: true,
      })).status !== 0) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      return;
    }

    log("provisioning firewall VM (first run takes ~5 min)...");
    this.writeGitLocalNix();
    this.ensureCa();
    await this.copyRepoIntoVm(this.config.firewallVm, VM_FILES.firewall);
    await this.copyGeneratedNetworkIntoVm(this.config.firewallVm);
    await this.providers.vm.exec(this.config.firewallVm, ["bash", "-lc", `
set -e
cd '${this.config.guestRepoDir}'
sudo nixos-rebuild switch --flake .#${this.nixosConfiguration("firewall")}
`]);
    await this.providers.vm.forgetSshHostKey?.(this.config.firewallVm);
    await this.syncFirewallCa();
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "systemctl",
      "restart",
      "mitmproxy-explicit",
      "mitmproxy-transparent",
    ]);
    log("firewall provisioning complete.");
  }

  private async ensureAgent(force: boolean): Promise<void> {
    let needsProvision = force;
    if ((await this.providers.vm.ensureRunning({
      role: "agent",
      name: this.config.agentVm,
      network: this.networkPlan.vms.agent,
    })).created) {
      needsProvision = true;
    }
    if (!needsProvision) {
      const hasPi = (await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", "command -v pi >/dev/null 2>&1"], {
        allowFailure: true,
        ignoredOutput: true,
      })).status === 0;
      if (!hasPi) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      return;
    }

    log("provisioning agent VM (first run takes ~10 min: nixpkgs fetch via firewall)...");
    this.writeGitLocalNix();
    await this.copyRepoIntoVm(this.config.agentVm, VM_FILES.agent);
    await this.copyGeneratedNetworkIntoVm(this.config.agentVm);
    await this.copyGeneratedGitIntoVm(this.config.agentVm);
    await this.copyAgentCaIntoVm(this.config.agentVm);
    await this.bootstrapAgentFirewallRoute();
    await this.bootstrapAgentFirewallTrust();
    await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", `
set -e
cd '${this.config.guestRepoDir}'
export NIX_SSL_CERT_FILE=/tmp/agent-vm-bootstrap-ca-bundle.crt
export SSL_CERT_FILE=/tmp/agent-vm-bootstrap-ca-bundle.crt
export GIT_SSL_CAINFO=/tmp/agent-vm-bootstrap-ca-bundle.crt
export REQUESTS_CA_BUNDLE=/tmp/agent-vm-bootstrap-ca-bundle.crt
sudo env \\
  NIX_SSL_CERT_FILE="$NIX_SSL_CERT_FILE" \\
  SSL_CERT_FILE="$SSL_CERT_FILE" \\
  GIT_SSL_CAINFO="$GIT_SSL_CAINFO" \\
  REQUESTS_CA_BUNDLE="$REQUESTS_CA_BUNDLE" \\
  nixos-rebuild switch --flake .#${this.nixosConfiguration("agent")}
nix run .#home-manager -- switch --flake .#${this.config.guestUser}
`]);
    await this.providers.vm.forgetSshHostKey?.(this.config.agentVm);
    log("agent provisioning complete.");
    const pubkey = (await this.providers.vm.execCapture(this.config.agentVm, ["cat", `/home/${this.config.guestUser}/.ssh/id_rsa.pub`], {
      allowFailure: true,
    })).stdout.trim();
    if (pubkey.length > 0) {
      process.stderr.write(`
rootcell: this VM's SSH public key (register at https://github.com/settings/keys
to enable \`git push git@github.com:...\` from inside the VM):

${pubkey}

Run \`./rootcell pubkey\` to print it again.

`);
    }
  }

  private readKeychainSecrets(): string[] {
    const path = this.config.secretsPath;
    if (!existsSync(path)) {
      return [];
    }
    let mappings;
    try {
      mappings = parseSecretMappings(readFileSync(path, "utf8"));
    } catch (error) {
      log(messageFromUnknown(error));
      process.exit(1);
    }

    const injected: string[] = [];
    for (const mapping of mappings) {
      const value = runCapture("security", ["find-generic-password", "-s", mapping.service, "-w"], {
        allowFailure: true,
      });
      if (value.status !== 0) {
        const serviceArg = shellQuote(mapping.service);
        process.stderr.write(`rootcell: Keychain secret not found for ${mapping.envName}.

Add it with:
  security add-generic-password -a "$USER" -s ${serviceArg} -w "<secret>"

Then re-run.
`);
        process.exit(1);
      }
      injected.push(`${mapping.envName}=${value.stdout.replace(/\r?\n$/, "")}`);
    }
    return injected;
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function hasInstanceFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--instance" || arg === "-i" || arg.startsWith("--instance=") || (arg.startsWith("-i") && arg.length > 2)) {
      return true;
    }
  }
  return false;
}

function appForInstance(repoDir: string, env: NodeJS.ProcessEnv, instance: RootcellInstance): RootcellApp<VmNetworkAttachment> {
  const config = buildConfig(repoDir, env, instance);
  return new RootcellApp(config, createProviderBundle(config, log));
}

async function runListCommand(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  instanceName: string,
  explicitInstance: boolean,
): Promise<number> {
  if (explicitInstance) {
    const instance = loadExistingRootcellInstance(repoDir, instanceName);
    if (instance === null) {
      process.stdout.write(formatVmList(missingVmEntries(instanceName)));
      return 0;
    }
    process.stdout.write(formatVmList(await appForInstance(repoDir, env, instance).listVms()));
    return 0;
  }

  const entries: VmListEntry[] = [];
  for (const name of listRootcellVmInstanceNames(repoDir)) {
    const instance = loadExistingRootcellInstance(repoDir, name);
    if (instance !== null) {
      entries.push(...await appForInstance(repoDir, env, instance).listVms());
    }
  }
  process.stdout.write(formatVmList(entries));
  return 0;
}

async function runLifecycleCommand(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  command: "stop" | "remove",
  instanceName: string,
): Promise<number> {
  const instance = loadExistingRootcellInstance(repoDir, instanceName);
  if (instance === null) {
    log(`rootcell instance '${instanceName}' not found; run ./rootcell --instance ${instanceName} first.`);
    return 1;
  }
  const app = appForInstance(repoDir, env, instance);
  if (command === "stop") {
    await app.stopVms();
    process.stdout.write(`stopped ${instanceName}\n`);
    return 0;
  }
  await app.removeVms();
  process.stdout.write(`stopped ${instanceName}, deleted state\n`);
  return 0;
}

function missingVmEntries(instanceName: string): readonly VmListEntry[] {
  const vmNames = deriveVmNames(instanceName);
  return [
    { instance: instanceName, vm: vmNames.agentVm, state: "missing" },
    { instance: instanceName, vm: vmNames.firewallVm, state: "missing" },
  ];
}

export async function rootcellMain(args: readonly string[], importMetaPath: string): Promise<number> {
  const repoDir = repoDirFromImportMeta(importMetaPath);
  let parsed;
  try {
    parsed = parseRootcellArgs(args);
  } catch (error) {
    log(messageFromUnknown(error));
    return 2;
  }

  if (parsed.kind === "handled") {
    return parsed.status;
  }

  try {
    if (parsed.subcommand === "list") {
      return await runListCommand(repoDir, process.env, parsed.instanceName, hasInstanceFlag(args));
    }
    if (parsed.subcommand === "stop" || parsed.subcommand === "remove") {
      return await runLifecycleCommand(repoDir, process.env, parsed.subcommand, parsed.instanceName);
    }

    seedRootcellInstanceFiles(repoDir, parsed.instanceName, log);
    loadDotEnv(join(repoDir, ".rootcell", "instances", parsed.instanceName, ".env"), process.env);
    const instance = loadRootcellInstance(repoDir, parsed.instanceName, process.env);
    const config = buildConfig(repoDir, process.env, instance);
    const app = new RootcellApp(config, createProviderBundle(config, log));
    return await app.runAfterEnvironment(parsed.subcommand, parsed.rest, parsed.spyOptions);
  } catch (error) {
    log(messageFromUnknown(error));
    return 1;
  }
}
