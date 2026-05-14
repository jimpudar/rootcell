import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseRootcellArgs } from "./args.ts";
import { loadDotEnv, nixString, parseSecretMappings } from "./env.ts";
import { deriveVmNames, loadRootcellInstance, seedRootcellInstanceFiles } from "./instance.ts";
import { commandExists, runAsyncInherited, runCapture, runInherited } from "./process.ts";
import type { RootcellConfig, RootcellInstance, SpyOptions, VmFileSet } from "./types.ts";

const GUEST_USER = "luser";
const SOCKET_VMNET_DST = "/opt/socket_vmnet/bin/socket_vmnet";
const ROOTCELL_VMNET_HELPER_DST = "/opt/rootcell/bin/rootcell-vmnet";
const ROOTCELL_VMNET_SUDOERS = "/private/etc/sudoers.d/rootcell-vmnet";

const VM_FILES: VmFileSet = {
  agent: [
    "flake.nix",
    "common.nix",
    "agent-vm.nix",
    "home.nix",
    "network.nix",
    "pi",
  ],
  firewall: [
    "flake.nix",
    "common.nix",
    "firewall-vm.nix",
    "network.nix",
    "proxy",
    "src/bin/reload.ts",
  ],
};

function log(message: string): void {
  console.error(`rootcell: ${message}`);
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
  return {
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
    vmnetUuid: instance.state.vmnetUuid,
    vmnetSocketPath: instance.state.socketPath,
    vmnetPidPath: instance.state.pidPath,
    vmStartTimeout: env.VM_START_TIMEOUT ?? "180s",
    socketVmnetDst: SOCKET_VMNET_DST,
    rootcellVmnetHelperSrc: join(repoDir, "src/bin/rootcell-vmnet-helper.sh"),
    rootcellVmnetHelperDst: ROOTCELL_VMNET_HELPER_DST,
  };
}

class RootcellApp {
  private limaBin: string;

  constructor(private readonly config: RootcellConfig) {
    this.limaBin = process.env.LIMACTL ?? "";
  }

  async runAfterEnvironment(subcommand: string, rest: readonly string[], spyOptions: SpyOptions): Promise<number> {
    this.writeNetworkLocalNix();

    if (subcommand === "pubkey") {
      return this.printPubkey();
    }

    this.ensureSocketVmnet();
    this.ensureRootcellVmnetHelper();
    this.ensureExistingVmNetworksCompatible();

    if (subcommand === "allow") {
      const status = this.vmStatus(this.config.firewallVm);
      if (status !== "Running") {
        log("firewall VM not running; start it with ./rootcell first.");
        return 1;
      }
      this.syncAllowlists();
      log("allowlists reloaded.");
      return 0;
    }

    this.ensureRootcellVmnet();
    this.ensureFirewall(subcommand === "provision");
    this.ensureCa();
    this.syncAllowlists();
    this.waitForFirewallListeners();

    if (subcommand === "spy") {
      return await this.runSpy(spyOptions);
    }

    this.ensureAgent(subcommand === "provision");
    if (subcommand === "provision") {
      log("done.");
      return 0;
    }

    const injectedSecretEnv = this.readKeychainSecrets();
    const command = rest.length === 0 ? ["bash", "-l"] : [...rest];
    return this.limactlInherited([
      "shell",
      this.config.agentVm,
      "env",
      ...injectedSecretEnv,
      `AWS_REGION=${process.env.AWS_REGION ?? "us-east-1"}`,
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
      "--",
      ...command,
    ], { allowFailure: true }).status;
  }

  private ensureLima(): void {
    if (this.limaBin.length > 0) {
      return;
    }
    const result = runCapture("nix", [
      "build",
      "--no-link",
      "--print-out-paths",
      `${this.config.repoDir}#lima`,
    ], { allowFailure: true });
    if (result.status !== 0) {
      log(`failed to build repo-patched Lima from ${this.config.repoDir}/flake.nix:`);
      process.stderr.write(prefixLines(result.stderr, "rootcell:   "));
      process.exit(1);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    this.limaBin = join(firstToken(result.stdout), "bin/limactl");
  }

  private limaEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      LIMA_DISABLE_DEFAULT_USERNET_FOR_VSOCK: this.config.agentVm,
    };
  }

  private limactlCapture(args: readonly string[], allowFailure = false): ReturnType<typeof runCapture> {
    this.ensureLima();
    return runCapture(this.limaBin, args, {
      env: this.limaEnv(),
      allowFailure,
    });
  }

  private limactlInherited(args: readonly string[], options: { readonly allowFailure?: boolean; readonly ignoredOutput?: boolean } = {}): ReturnType<typeof runInherited> {
    this.ensureLima();
    return runInherited(this.limaBin, args, {
      env: this.limaEnv(),
      ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
      ...(options.ignoredOutput === undefined ? {} : { ignoredOutput: options.ignoredOutput }),
    });
  }

  private async limactlAsyncInherited(args: readonly string[]): Promise<number> {
    this.ensureLima();
    return await runAsyncInherited(this.limaBin, args, { env: this.limaEnv() });
  }

  private writeNetworkLocalNix(): void {
    const content = [
      "# Generated by ./rootcell from this instance's state. DO NOT EDIT.",
      "{",
      `  firewallIp    = ${nixString(this.config.firewallIp)};`,
      `  agentIp       = ${nixString(this.config.agentIp)};`,
      `  networkPrefix = ${this.config.networkPrefix};`,
      "}",
      "",
    ].join("\n");
    writeFileSync(join(this.config.generatedDir, "network-local.nix"), content, "utf8");
  }

  private printPubkey(): number {
    const status = this.limactlCapture(["list", "--format", "{{.Status}}", this.config.agentVm], true).stdout.trim();
    if (status !== "Running") {
      log("agent VM not running; start it with ./rootcell first.");
      return 1;
    }
    const keyPath = `/home/${this.config.guestUser}/.ssh/id_rsa.pub`;
    const keyExists = this.limactlInherited(["shell", this.config.agentVm, "--", "test", "-f", keyPath], {
      allowFailure: true,
      ignoredOutput: true,
    }).status === 0;
    if (!keyExists) {
      log("no SSH key in agent VM yet; run ./rootcell provision first.");
      return 1;
    }
    return this.limactlInherited(["shell", this.config.agentVm, "--", "cat", keyPath], { allowFailure: true }).status;
  }

  private ensureSocketVmnet(): void {
    const result = runCapture("nix", [
      "build",
      "--no-link",
      "--print-out-paths",
      `${this.config.repoDir}#socket_vmnet`,
    ], { allowFailure: true });
    if (result.status !== 0) {
      log(`failed to build socket_vmnet from ${this.config.repoDir}/pkgs/socket_vmnet.nix:`);
      process.stderr.write(result.stderr);
      process.exit(1);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    const out = firstToken(result.stdout);
    const nixBin = join(out, "bin/socket_vmnet");
    if (existsSync(this.config.socketVmnetDst)) {
      const cmp = runInherited("cmp", ["-s", nixBin, this.config.socketVmnetDst], {
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
    const helperOk = existsSync(this.config.rootcellVmnetHelperDst)
      && runInherited("cmp", ["-s", this.config.rootcellVmnetHelperSrc, this.config.rootcellVmnetHelperDst], {
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
    ${shellQuote(this.config.rootcellVmnetHelperSrc)} \\
    ${shellQuote(this.config.rootcellVmnetHelperDst)}
  sudo chown root:wheel ${shellQuote(this.config.rootcellVmnetHelperDst)}
  printf '%s\\n' '%staff ALL=(root:wheel) NOPASSWD:NOSETENV: ${this.config.rootcellVmnetHelperDst} *' \\
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
      return readFileSync(ROOTCELL_VMNET_SUDOERS, "utf8").includes(this.config.rootcellVmnetHelperDst);
    } catch {
      return true;
    }
  }

  private vmStatus(name: string): string {
    return this.limactlCapture(["list", "--format", "{{.Status}}", name], true).stdout.trim();
  }

  private forceStopIfRunning(name: string): void {
    if (this.vmStatus(name) === "Running") {
      log(`force-stopping ${name} VM to repair stale ${this.config.instanceName} vmnet daemon...`);
      this.limactlInherited(["stop", "--force", name]);
    }
  }

  private ensureRootcellVmnet(): void {
    const status = runCapture("sudo", [
      "-n",
      this.config.rootcellVmnetHelperDst,
      "status",
      this.config.instanceName,
    ], { allowFailure: true });
    if (status.status === 0) {
      return;
    }
    if (status.status !== 1 || status.stderr.length > 0) {
      process.stderr.write(status.stderr);
      log("failed to check rootcell vmnet helper status.");
      process.exit(1);
    }
    log(`starting isolated vmnet daemon for instance '${this.config.instanceName}' (${this.config.firewallIp}/24, ${this.config.agentIp}/24)...`);
    this.forceStopIfRunning(this.config.agentVm);
    this.forceStopIfRunning(this.config.firewallVm);
    const start = runInherited("sudo", [
      "-n",
      this.config.rootcellVmnetHelperDst,
      "start",
      this.config.instanceName,
      this.config.vmnetUuid,
    ], { allowFailure: true });
    if (start.status !== 0) {
      log("failed to start rootcell vmnet helper.");
      process.exit(1);
    }
  }

  private ensureExistingVmNetworksCompatible(): void {
    for (const name of [this.config.firewallVm, this.config.agentVm]) {
      if (this.vmStatus(name) === "") {
        continue;
      }
      if (this.vmUsesInstanceSocket(name)) {
        continue;
      }
      log(`${name} exists but was not created for rootcell instance '${this.config.instanceName}'.`);
      log(`Delete and recreate it to migrate to the isolated socket vmnet network: limactl delete ${name} --force`);
      process.exit(1);
    }
  }

  private vmUsesInstanceSocket(name: string): boolean {
    const result = this.limactlCapture(["list", name, "--json"], true);
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return false;
    }
    try {
      return jsonContainsSocket(JSON.parse(result.stdout), this.config.vmnetSocketPath);
    } catch {
      return result.stdout.includes(`"socket":${JSON.stringify(this.config.vmnetSocketPath)}`);
    }
  }

  private diagnoseStartFailure(name: string): void {
    const logFile = join(homedir(), ".lima", name, "ha.stderr.log");
    if (!existsSync(logFile)) {
      return;
    }
    const tail = readFileSync(logFile, "utf8").split(/\r?\n/).slice(-80).join("\n");
    if (/Waiting for port to become available on .*:22/.test(tail) && !tail.includes("Started vsock forwarder")) {
      log(`${name} VM did not establish Lima SSH over VSOCK.`);
      log("Lima is waiting for guest TCP/22 on its default usernet path.");
      log("The agent VM should be started with this repo's patched Lima, which skips that usernet NIC and polls VSOCK directly for SSH.");
    }
  }

  private startVm(name: string): void {
    const result = this.limactlInherited(["start", "--timeout", this.config.vmStartTimeout, name], {
      allowFailure: true,
    });
    if (result.status === 0) {
      return;
    }
    this.diagnoseStartFailure(name);
    process.exit(1);
  }

  private ensureVmRunning(name: string, configPath: string): boolean {
    const status = this.vmStatus(name);
    switch (status) {
      case "Running":
        return false;
      case "Stopped":
        log(`starting ${name} VM...`);
        this.startVm(name);
        return false;
      case "":
        log(`${name} VM not found; creating (~3-5 min for image + boot)...`);
        {
          const result = this.limactlInherited([
            "start",
            "--timeout",
            this.config.vmStartTimeout,
            "--tty=false",
            `--name=${name}`,
            "--set",
            `.user.name = "${this.config.guestUser}"`,
            "--set",
            `.networks[0].socket = ${nixString(this.config.vmnetSocketPath)}`,
            "--set",
            ".ssh.overVsock = true",
            configPath,
          ], { allowFailure: true });
          if (result.status !== 0) {
            this.diagnoseStartFailure(name);
            log(`limactl start ${name} failed; aborting.`);
            process.exit(1);
          }
        }
        return true;
      default:
        log(`${name} VM in unexpected state: '${status}'. Aborting.`);
        process.exit(1);
    }
  }

  private bootstrapAgentFirewallRoute(): void {
    const script = `
set -euo pipefail
iface=enp0s1
if [ -e /sys/class/net/enp0s2 ]; then
  iface=enp0s2
fi
systemctl stop dhcpcd.service 2>/dev/null || true
ip link set "$iface" up
ip addr flush dev "$iface"
ip addr add '${this.config.agentIp}/${this.config.networkPrefix}' dev "$iface"
ip route replace default via '${this.config.firewallIp}' dev "$iface"
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl dns "$iface" '${this.config.firewallIp}' || true
  resolvectl domain "$iface" '~.' || true
fi
printf 'nameserver %s\\n' '${this.config.firewallIp}' > /etc/resolv.conf
`;
    this.limactlInherited(["shell", this.config.agentVm, "--", "sudo", "bash", "-lc", script]);
  }

  private bootstrapAgentFirewallTrust(): void {
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
    this.limactlInherited(["shell", this.config.agentVm, "--", "bash", "-lc", script]);
  }

  private copyRepoIntoVm(vm: string, files: readonly string[]): void {
    this.limactlInherited(["shell", vm, "--", "mkdir", "-p", this.config.guestRepoDir]);
    for (const file of files) {
      const parent = dirname(file);
      const guestParent = parent === "." ? this.config.guestRepoDir : join(this.config.guestRepoDir, parent);
      this.limactlInherited(["shell", vm, "--", "mkdir", "-p", guestParent]);
      this.limactlInherited([
        "cp",
        "-r",
        join(this.config.repoDir, file),
        `${vm}:${guestParent}/`,
      ]);
    }
  }

  private copyHostFileIntoVm(vm: string, hostPath: string, guestPath: string): void {
    this.limactlInherited(["shell", vm, "--", "mkdir", "-p", dirname(guestPath)]);
    this.limactlInherited(["cp", hostPath, `${vm}:${guestPath}`]);
  }

  private copyGeneratedNetworkIntoVm(vm: string): void {
    this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "network-local.nix"),
      join(this.config.guestRepoDir, "network-local.nix"),
    );
  }

  private copyGeneratedGitIntoVm(vm: string): void {
    this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "git-local.nix"),
      join(this.config.guestRepoDir, "git-local.nix"),
    );
  }

  private copyAgentCaIntoVm(vm: string): void {
    this.copyHostFileIntoVm(
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

  private waitForFirewallListeners(): void {
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
    const ready = this.limactlInherited(["shell", this.config.firewallVm, "--", "bash", "-c", probe], {
      allowFailure: true,
      ignoredOutput: true,
    }).status === 0;
    if (ready) {
      return;
    }
    log("timeout waiting for firewall services");
    this.limactlInherited([
      "shell",
      this.config.firewallVm,
      "--",
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

  private syncAllowlists(): void {
    for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
      this.limactlInherited([
        "cp",
        join(this.config.proxyDir, file),
        `${this.config.firewallVm}:/etc/agent-vm/${file}`,
      ]);
    }
    this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "/etc/agent-vm/reload.sh"]);
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

  private syncFirewallCa(): void {
    const pem = join(this.config.pkiDir, "agent-vm-ca.pem");
    this.limactlInherited(["cp", pem, `${this.config.firewallVm}:/tmp/.agent-vm-ca.pem.staged`]);
    this.limactlInherited([
      "shell",
      this.config.firewallVm,
      "--",
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
    this.limactlInherited(["shell", this.config.firewallVm, "--", "rm", "-f", "/tmp/.agent-vm-ca.pem.staged"]);
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
    this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "install", "-d", "-m", "1777", "/run/agent-vm-spy"]);
    this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "install", "-m", "0666", "/dev/null", "/run/agent-vm-spy/events.ndjson"]);
    this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "touch", "/run/agent-vm-spy/enabled", spySession]);
    this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "chmod", "0666", "/run/agent-vm-spy/enabled", spySession]);

    const cleanup = (): void => {
      const script = `
rm -f '${spySession}'
if ls /run/agent-vm-spy/enabled.* >/dev/null 2>&1; then
  touch /run/agent-vm-spy/enabled
  chmod 0666 /run/agent-vm-spy/enabled
else
  rm -f /run/agent-vm-spy/enabled
fi
`;
      this.limactlInherited(["shell", this.config.firewallVm, "--", "sudo", "sh", "-lc", script], {
        allowFailure: true,
        ignoredOutput: true,
      });
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      cleanup();
      process.exit(signal === "SIGINT" ? 130 : 143);
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
      status = await this.limactlAsyncInherited([
        "shell",
        this.config.firewallVm,
        "--",
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
      status = await this.limactlAsyncInherited([
        "shell",
        this.config.firewallVm,
        "--",
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
    cleanup();
    return status;
  }

  private ensureFirewall(force: boolean): void {
    let needsProvision = force;
    if (this.ensureVmRunning(this.config.firewallVm, join(this.config.repoDir, "firewall.yaml"))) {
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
      if (this.limactlInherited(["shell", this.config.firewallVm, "--", "bash", "-lc", check], {
        allowFailure: true,
        ignoredOutput: true,
      }).status !== 0) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      return;
    }

    log("provisioning firewall VM (first run takes ~5 min)...");
    this.writeGitLocalNix();
    this.ensureCa();
    this.copyRepoIntoVm(this.config.firewallVm, VM_FILES.firewall);
    this.copyGeneratedNetworkIntoVm(this.config.firewallVm);
    this.limactlInherited(["shell", this.config.firewallVm, "--", "bash", "-lc", `
set -e
cd '${this.config.guestRepoDir}'
sudo nixos-rebuild switch --flake .#firewall-vm
`]);
    this.syncFirewallCa();
    this.limactlInherited([
      "shell",
      this.config.firewallVm,
      "--",
      "sudo",
      "systemctl",
      "restart",
      "mitmproxy-explicit",
      "mitmproxy-transparent",
    ]);
    log("firewall provisioning complete.");
  }

  private ensureAgent(force: boolean): void {
    let needsProvision = force;
    if (this.ensureVmRunning(this.config.agentVm, join(this.config.repoDir, "nixos.yaml"))) {
      needsProvision = true;
    }
    if (!needsProvision) {
      const hasPi = this.limactlInherited(["shell", this.config.agentVm, "--", "bash", "-lc", "command -v pi >/dev/null 2>&1"], {
        allowFailure: true,
        ignoredOutput: true,
      }).status === 0;
      if (!hasPi) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      return;
    }

    log("provisioning agent VM (first run takes ~10 min: nixpkgs fetch via firewall)...");
    this.writeGitLocalNix();
    this.copyRepoIntoVm(this.config.agentVm, VM_FILES.agent);
    this.copyGeneratedNetworkIntoVm(this.config.agentVm);
    this.copyGeneratedGitIntoVm(this.config.agentVm);
    this.copyAgentCaIntoVm(this.config.agentVm);
    this.bootstrapAgentFirewallRoute();
    this.bootstrapAgentFirewallTrust();
    this.limactlInherited(["shell", this.config.agentVm, "--", "bash", "-lc", `
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
  nixos-rebuild switch --flake .#agent-vm
nix run nixpkgs#home-manager -- switch --flake .#${this.config.guestUser}
`]);
    log("agent provisioning complete.");
    const pubkey = this.limactlCapture(["shell", this.config.agentVm, "--", "cat", `/home/${this.config.guestUser}/.ssh/id_rsa.pub`], true).stdout.trim();
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

function prefixLines(text: string, prefix: string): string {
  return text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => `${prefix}${line}`).join("\n") + "\n";
}

function jsonContainsSocket(value: unknown, socketPath: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsSocket(item, socketPath));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "socket" && child === socketPath) {
      return true;
    }
    if (jsonContainsSocket(child, socketPath)) {
      return true;
    }
  }
  return false;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    seedRootcellInstanceFiles(repoDir, parsed.instanceName, log);
    loadDotEnv(join(repoDir, ".rootcell", "instances", parsed.instanceName, ".env"), process.env);
    const instance = loadRootcellInstance(repoDir, parsed.instanceName, process.env);
    const app = new RootcellApp(buildConfig(repoDir, process.env, instance));
    return await app.runAfterEnvironment(parsed.subcommand, parsed.rest, parsed.spyOptions);
  } catch (error) {
    log(messageFromUnknown(error));
    return 1;
  }
}
