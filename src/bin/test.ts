#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import { runCapture, runInherited } from "../rootcell/process.ts";

const REPO_DIR = findRepoDir(import.meta.path);
const TEST_INSTANCE = "test";
const LIFECYCLE_INSTANCE = "lifecycle-test";
const AGENT_VM_NAME = "agent-test";
const FIREWALL_VM_NAME = "firewall-test";
const FIREWALL_IP = "192.168.109.2";
const AGENT_IP = "192.168.109.3";
const JsonObjectSchema = z.record(z.string(), z.unknown());
let teeCommandIndex = 0;

interface TestCase {
  readonly name: string;
  readonly run: () => void;
}

interface ParsedTestArgs {
  readonly teardown: boolean;
  readonly clean: boolean;
}

class TestFailure extends Error {}

function log(message: string): void {
  console.error(`test: ${message}`);
}

function findRepoDir(importMetaPath: string): string {
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

function parseArgs(args: readonly string[]): ParsedTestArgs {
  const first = args[0] ?? "";
  switch (first) {
    case "":
      return { teardown: false, clean: false };
    case "--teardown":
      return { teardown: true, clean: false };
    case "--clean":
      return { teardown: false, clean: true };
    default:
      console.error(`usage: ${process.argv[1] ?? "./test"} [--teardown|--clean]`);
      process.exit(2);
  }
}

function commandOk(command: string, args: readonly string[]): string {
  const result = runCapture(command, args, { allowFailure: true });
  if (result.status !== 0) {
    throw new TestFailure(result.stderr.length > 0 ? result.stderr : result.stdout);
  }
  return result.stdout;
}

function commandOkTee(command: string, args: readonly string[]): string {
  const logPath = teeLogPath();
  const result = runInherited("bash", [
    "-lc",
    'set -o pipefail; log_path=$1; shift; "$@" 2>&1 | tee "$log_path"',
    "bash",
    logPath,
    command,
    ...args,
  ], { allowFailure: true });
  const output = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  if (result.status !== 0) {
    throw new TestFailure(output.length > 0 ? output : `command failed (${String(result.status)}): ${command}`);
  }
  rmSync(logPath, { force: true });
  return output;
}

function teeLogPath(): string {
  const dir = join(REPO_DIR, ".rootcell", "test-logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  teeCommandIndex += 1;
  return join(dir, `command-${String(process.pid)}-${String(teeCommandIndex)}.log`);
}

function commandFails(command: string, args: readonly string[]): void {
  const result = runCapture(command, args, { allowFailure: true });
  if (result.status === 0) {
    throw new TestFailure(result.stdout.length > 0 ? result.stdout : "command unexpectedly succeeded");
  }
}

function rootcell(args: readonly string[]): string {
  return commandOkTee(join(REPO_DIR, "rootcell"), args);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function agentSh(script: string): string {
  return sshGuest("rootcell-agent", script);
}

function agentShCapture(script: string): ReturnType<typeof runCapture> {
  return runCapture("ssh", ["-F", sshConfigPath(), "rootcell-agent", `bash -lc ${shellQuote(script)}`], {
    allowFailure: true,
  });
}

function firewallSh(script: string): string {
  return sshGuest("rootcell-firewall", script);
}

function agentShFails(script: string): void {
  commandFails("ssh", ["-F", sshConfigPath(), "rootcell-agent", `bash -lc ${shellQuote(script)}`]);
}

function sshGuest(alias: "rootcell-agent" | "rootcell-firewall", script: string): string {
  return commandOk("ssh", ["-F", sshConfigPath(), alias, `bash -lc ${shellQuote(script)}`]);
}

function sshConfigPath(): string {
  return join(REPO_DIR, ".rootcell", "instances", TEST_INSTANCE, "ssh", "config");
}

function vfkitStatePath(name: string): string {
  return join(REPO_DIR, ".rootcell", "instances", TEST_INSTANCE, "vfkit", name, "state.json");
}

function vfkitPrivateLinkStatePath(): string {
  return join(REPO_DIR, ".rootcell", "instances", TEST_INSTANCE, "vfkit", "network", "private-link.json");
}

function lifecycleInstanceDir(): string {
  return join(REPO_DIR, ".rootcell", "instances", LIFECYCLE_INSTANCE);
}

function readJson(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return JsonObjectSchema.parse(raw);
}

function pidFromState(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  const pid = readJson(path).pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) ? pid : null;
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

function stopPidFromState(path: string): void {
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
    Bun.sleepSync(100);
  }
  try {
    process.kill(pid, "KILL");
  } catch {
    // The process exited between polls.
  }
}

function stopVfkitVm(name: string): void {
  stopPidFromState(vfkitStatePath(name));
}

function stopVfkitInstance(): void {
  stopVfkitVm(AGENT_VM_NAME);
  stopVfkitVm(FIREWALL_VM_NAME);
  stopPidFromState(vfkitPrivateLinkStatePath());
}

function stopLifecycleProcesses(): void {
  for (const path of [
    join(lifecycleInstanceDir(), "vfkit", `agent-${LIFECYCLE_INSTANCE}`, "state.json"),
    join(lifecycleInstanceDir(), "vfkit", `firewall-${LIFECYCLE_INSTANCE}`, "state.json"),
    join(lifecycleInstanceDir(), "vfkit", "network", "private-link.json"),
  ]) {
    stopPidFromState(path);
  }
}

function vfkitVmIsRunning(name: string): void {
  const pid = pidFromState(vfkitStatePath(name));
  if (pid === null || !processIsRunning(pid)) {
    throw new TestFailure(`${name} vfkit process is not running`);
  }
}

function assertRootcellListState(output: string, instance: string, vm: string, state: string): void {
  const rows = output.split(/\r?\n/).slice(1).filter((line) => line.trim().length > 0);
  const found = rows.some((line) => {
    const cells = line.trim().split(/\s+/);
    return cells[0] === instance && cells[1] === vm && cells[2] === state;
  });
  if (!found) {
    throw new TestFailure(`expected rootcell list row ${instance} ${vm} ${state}, got:\n${output}`);
  }
}

function rootcellListReportsTestVmsRunning(): void {
  const output = rootcell(["list", "--instance", TEST_INSTANCE]);
  assertRootcellListState(output, TEST_INSTANCE, AGENT_VM_NAME, "running");
  assertRootcellListState(output, TEST_INSTANCE, FIREWALL_VM_NAME, "running");
}

function rootcellStopRestartsViaWrapper(): void {
  const stopOutput = rootcell(["stop", "--instance", TEST_INSTANCE]);
  if (!stopOutput.includes(`stopped ${TEST_INSTANCE}`)) {
    throw new TestFailure(`unexpected rootcell stop output: ${stopOutput}`);
  }
  const stoppedOutput = rootcell(["list", "--instance", TEST_INSTANCE]);
  assertRootcellListState(stoppedOutput, TEST_INSTANCE, AGENT_VM_NAME, "stopped");
  assertRootcellListState(stoppedOutput, TEST_INSTANCE, FIREWALL_VM_NAME, "stopped");

  rootcell(["--instance", TEST_INSTANCE, "true"]);
  syncDefaultAllowlists();
  agentSh("true");
  rootcellListReportsTestVmsRunning();
}

function rootcellRemoveDeletesLifecycleVmState(): void {
  prepareLifecycleInstance();
  try {
    const existing = rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
    assertRootcellListState(existing, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "stopped");
    assertRootcellListState(existing, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "stopped");

    const stopOutput = rootcell(["stop", "--instance", LIFECYCLE_INSTANCE]);
    if (!stopOutput.includes(`stopped ${LIFECYCLE_INSTANCE}`)) {
      throw new TestFailure(`unexpected lifecycle stop output: ${stopOutput}`);
    }
    const stopped = rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
    assertRootcellListState(stopped, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "stopped");
    assertRootcellListState(stopped, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "stopped");

    const removeOutput = rootcell(["remove", "--instance", LIFECYCLE_INSTANCE]);
    if (!removeOutput.includes(`stopped ${LIFECYCLE_INSTANCE}, deleted state`)) {
      throw new TestFailure(`unexpected lifecycle remove output: ${removeOutput}`);
    }
    for (const path of [
      join(lifecycleInstanceDir(), "vfkit", `agent-${LIFECYCLE_INSTANCE}`),
      join(lifecycleInstanceDir(), "vfkit", `firewall-${LIFECYCLE_INSTANCE}`),
      join(lifecycleInstanceDir(), "vfkit", "network"),
    ]) {
      if (existsSync(path)) {
        throw new TestFailure(`rootcell remove left vfkit state behind: ${path}`);
      }
    }
    const missing = rootcell(["list", "--instance", LIFECYCLE_INSTANCE]);
    assertRootcellListState(missing, LIFECYCLE_INSTANCE, `agent-${LIFECYCLE_INSTANCE}`, "missing");
    assertRootcellListState(missing, LIFECYCLE_INSTANCE, `firewall-${LIFECYCLE_INSTANCE}`, "missing");
  } finally {
    stopLifecycleProcesses();
    rmSync(lifecycleInstanceDir(), { recursive: true, force: true });
  }
}

function prepareLifecycleInstance(): void {
  stopLifecycleProcesses();
  rmSync(lifecycleInstanceDir(), { recursive: true, force: true });
  mkdirSync(lifecycleInstanceDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(lifecycleInstanceDir(), "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    subnet: "192.168.110.0",
    networkPrefix: 24,
    firewallIp: "192.168.110.2",
    agentIp: "192.168.110.3",
  }, null, 2)}\n`, "utf8");
  writeStoppedLifecycleVmState(`agent-${LIFECYCLE_INSTANCE}`);
  writeStoppedLifecycleVmState(`firewall-${LIFECYCLE_INSTANCE}`);
  mkdirSync(join(lifecycleInstanceDir(), "vfkit", "network"), { recursive: true, mode: 0o700 });
}

function writeStoppedLifecycleVmState(name: string): void {
  const dir = join(lifecycleInstanceDir(), "vfkit", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "disk.raw"), "");
}

function syncDefaultAllowlists(): void {
  log("syncing .defaults allowlists into test firewall...");
  const proxyDir = join(REPO_DIR, ".rootcell", "instances", TEST_INSTANCE, "proxy");
  mkdirSync(proxyDir, { recursive: true, mode: 0o700 });
  for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
    copyFileSync(join(REPO_DIR, "proxy", `${file}.defaults`), join(proxyDir, file));
  }
  rootcell(["--instance", TEST_INSTANCE, "allow"]);
}

function denySniNoBypassWithInsecureCurl(): void {
  const result = agentShCapture('curl -sk --max-time 10 -o /dev/null -w "%{size_download}" https://pythonhosted.org');
  const size = (result.stdout.trim() || "0");
  if (size !== "0") {
    throw new TestFailure(`deny path leaked: curl -k against denied SNI downloaded ${size} bytes`);
  }
}

function denySniNoMitmproxyCert(): void {
  const out = agentShCapture("curl -skv --max-time 10 -o /dev/null https://pythonhosted.org 2>&1 | grep -i issuer").stdout;
  if (/mitmproxy/i.test(out)) {
    throw new TestFailure(`denied SNI received a mitmproxy-issued cert: ${out}`);
  }
}

function allowedHttpsCertIsOurs(): void {
  const issuer = agentSh("curl -sSv --max-time 10 -o /dev/null https://github.com 2>&1 | grep -i \"issuer:\" | head -n1");
  if (!issuer.includes("agent-vm proxy CA")) {
    throw new TestFailure(`expected mitmproxy-minted cert (issuer=agent-vm proxy CA), got: ${issuer}`);
  }
}

function sniPinnedToUpstreamIdentity(): void {
  const out = agentShCapture("curl -sk --max-time 10 -D - --resolve github.com:443:1.1.1.1 https://github.com").stdout;
  if (out.length === 0) {
    return;
  }
  if (/^server: mitmproxy/im.test(out) && /Certificate verify failed: hostname mismatch/i.test(out)) {
    return;
  }
  throw new TestFailure(`MITM bypass: SNI=github.com routed to 1.1.1.1 returned unexpected response:\n${out.split(/\r?\n/).slice(0, 20).join("\n")}`);
}

function hostMustAgreeWithSni(): void {
  const code = agentShCapture('curl -sS --max-time 10 -o /dev/null -w "%{http_code}" -H "Host: objects.githubusercontent.com" https://api.github.com/').stdout.trim();
  if (code === "000" || code.length === 0) {
    return;
  }
  throw new TestFailure(`Host/SNI mismatch leaked: got HTTP ${code} from api.github.com with Host: objects.githubusercontent.com`);
}

function vfkitCases(): TestCase[] {
  return [
    { name: "agent vfkit process is running", run: () => { vfkitVmIsRunning(AGENT_VM_NAME); } },
    { name: "firewall vfkit process is running", run: () => { vfkitVmIsRunning(FIREWALL_VM_NAME); } },
    { name: "rootcell list reports test VMs running", run: rootcellListReportsTestVmsRunning },
    { name: "rootcell remove deletes vfkit state", run: rootcellRemoveDeletesLifecycleVmState },
    { name: "SSH config uses ProxyJump for agent", run: () => {
      const config = readFileSync(sshConfigPath(), "utf8");
      if (!config.includes("Host rootcell-firewall") || !config.includes("Host rootcell-agent") || !config.includes("ProxyJump rootcell-firewall")) {
        throw new TestFailure("vfkit SSH config is missing firewall, agent, or ProxyJump entries");
      }
    } },
    { name: "host can SSH to firewall directly", run: () => firewallSh("true") },
    { name: "host can SSH to agent through ProxyJump", run: () => agentSh("true") },
    { name: "agent VM has exactly one non-loopback NIC", run: () => agentSh('test "$(find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo | wc -l | tr -d " ")" = 1') },
    { name: "agent VM has no host-visible control NIC", run: () => {
      const state = readJson(vfkitStatePath(AGENT_VM_NAME));
      if (state.controlMac !== undefined) {
        throw new TestFailure("agent vfkit state unexpectedly has a control NIC");
      }
    } },
    { name: "host has no direct SSH path to agent private IP", run: () => {
      commandFails("ssh", [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=3",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `luser@${AGENT_IP}`,
        "true",
      ]);
    } },
  ];
}

function sharedCases(): TestCase[] {
  return [
    { name: "rootcell stop stops VMs and provision restarts them", run: rootcellStopRestartsViaWrapper },
    { name: "firewall services active", run: () => firewallSh("systemctl is-active mitmproxy-explicit mitmproxy-transparent dnsmasq >/dev/null") },
    { name: "agent spy --help is wired", run: () => commandOk("bash", ["-c", `'${join(REPO_DIR, "rootcell")}' --instance ${TEST_INSTANCE} spy --help | grep -q -- '--tui'`]) },
    { name: "agent spy tui flags parse with help", run: () => commandOk("bash", ["-c", `'${join(REPO_DIR, "rootcell")}' --instance ${TEST_INSTANCE} spy --tui --raw --no-dedupe --help | grep -q -- '--tui'`]) },
    { name: "firewall spy formatter installed", run: () => firewallSh('test -x /etc/agent-vm/agent_spy.py && test -x /etc/agent-vm/agent_spy_tui.py && command -v python3 >/dev/null && python3 -c "import textual" && test -d /run/agent-vm-spy') },
    { name: "agent VM has test IP on enp0s1", run: () => agentSh(`ip -4 -o addr show enp0s1 | grep -q '${AGENT_IP}/'`) },
    { name: "agent VM has no second virtio-net NIC", run: () => agentSh("! ip link show enp0s2 >/dev/null 2>&1") },
    { name: "agent VM routes default traffic through firewall", run: () => agentSh(`ip route show default | grep -q '^default via ${FIREWALL_IP} dev enp0s1'`) },
    { name: "agent VM has no direct usernet address", run: () => agentSh("! ip -4 -o addr show | grep -q '192\\.168\\.5\\.'") },
    { name: "firewall VM has test IP on enp0s2", run: () => firewallSh(`ip -4 -o addr show enp0s2 | grep -q '${FIREWALL_IP}/'`) },
    { name: "agent reaches firewall dnsmasq on private link", run: () => agentSh(`dig @${FIREWALL_IP} +short +time=5 +tries=1 github.com | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'`) },
    { name: "home-manager dev CLIs on PATH", run: () => agentSh("command -v pi && command -v rg && command -v gh && command -v jq >/dev/null") },
    { name: "pi --help runs", run: () => agentSh('out=$(pi --help) && [ -n "$out" ]') },
    { name: "HTTPS allowed: github.com", run: () => agentSh('code=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" https://github.com) && [[ "$code" =~ ^[23] ]]') },
    { name: "HTTP denied: even allowed host fails over cleartext (github.com:80)", run: () => { agentShFails("curl -sS --max-time 5 -o /dev/null http://github.com"); } },
    { name: "HTTPS denied via DNS: example.com (curl fails)", run: () => { agentShFails("curl -sS --max-time 10 -o /dev/null https://example.com"); } },
    { name: "HTTPS denied via SNI: pythonhosted.org (DNS-allowed, SNI-not-allowed)", run: () => { agentShFails("curl -sS --max-time 10 -o /dev/null https://pythonhosted.org"); } },
    { name: "HTTPS deny path: insecure curl (-k) yields no upstream bytes", run: denySniNoBypassWithInsecureCurl },
    { name: "HTTPS deny path: no mitmproxy-issued cert for denied SNI", run: denySniNoMitmproxyCert },
    { name: "HTTPS allowed: cert issuer is our deployment CA (proves MITM is on)", run: allowedHttpsCertIsOurs },
    { name: "HTTPS MITM: SNI-vs-upstream-IP mismatch denied", run: sniPinnedToUpstreamIdentity },
    { name: "HTTPS MITM: Host header must agree with SNI", run: hostMustAgreeWithSni },
    { name: "DNS allowed: github.com resolves to an IP", run: () => { agentSh('dig +short +time=5 +tries=1 github.com | grep -qE "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"'); } },
    { name: "DNS denied: example.com returns REFUSED", run: () => { agentSh('dig example.com +time=5 +tries=1 2>&1 | grep -q "status: REFUSED"'); } },
    { name: "SSH allowed: github.com (CONNECT succeeds)", run: () => agentSh('ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -T git@github.com 2>&1 | grep -qE "(successfully authenticated|Permission denied|does not provide shell)"') },
    { name: "SSH denied: 1.1.1.1 (ssh fails)", run: () => { agentShFails("ssh -o BatchMode=yes -o ConnectTimeout=10 -T -p 22 root@1.1.1.1"); } },
  ];
}

function buildCases(): TestCase[] {
  return [...vfkitCases(), ...sharedCases()];
}

function runCase(testCase: TestCase): boolean {
  try {
    testCase.run();
    console.log(`[PASS] ${testCase.name}`);
    return true;
  } catch (error) {
    console.log(`[FAIL] ${testCase.name}`);
    const message = error instanceof Error ? error.message : String(error);
    if (message.length > 0) {
      console.log(`  ${message.replaceAll("\n", "\n  ")}`);
    }
    return false;
  }
}

function removeTestInstanceState(): void {
  stopVfkitInstance();
  stopLifecycleProcesses();
  rmSync(join(REPO_DIR, ".rootcell", "instances", TEST_INSTANCE), {
    recursive: true,
    force: true,
  });
  rmSync(lifecycleInstanceDir(), {
    recursive: true,
    force: true,
  });
}

function main(args: readonly string[]): number {
  const parsed = parseArgs(args);
  process.env.FIREWALL_IP = FIREWALL_IP;
  process.env.AGENT_IP = AGENT_IP;
  process.env.NETWORK_PREFIX = "24";

  if (parsed.teardown) {
    log("deleting test VMs...");
    stopVfkitInstance();
    removeTestInstanceState();
    return 0;
  }
  if (parsed.clean) {
    log("deleting test VMs for a fresh provision...");
    stopVfkitInstance();
    removeTestInstanceState();
  }

  log("provisioning vfkit test VMs (first run takes ~15 min)...");
  rootcell(["--instance", TEST_INSTANCE, "provision"]);
  syncDefaultAllowlists();
  log("running tests...");

  let pass = 0;
  let fail = 0;
  const failed: string[] = [];
  for (const testCase of buildCases()) {
    if (runCase(testCase)) {
      pass += 1;
    } else {
      fail += 1;
      failed.push(testCase.name);
    }
  }

  console.log("");
  console.log(`Results: ${String(pass)} passed, ${String(fail)} failed`);
  if (fail > 0) {
    console.log("Failed:");
    for (const name of failed) {
      console.log(`  - ${name}`);
    }
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
