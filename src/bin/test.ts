#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { runCapture, runInherited } from "../rootcell/process.ts";

const REPO_DIR = findRepoDir(import.meta.path);
const AGENT_VM_NAME = "agent-test";
const FIREWALL_VM_NAME = "firewall-test";
const FIREWALL_IP = "192.168.106.10";
const AGENT_IP = "192.168.106.11";

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

function commandFails(command: string, args: readonly string[]): void {
  const result = runCapture(command, args, { allowFailure: true });
  if (result.status === 0) {
    throw new TestFailure(result.stdout.length > 0 ? result.stdout : "command unexpectedly succeeded");
  }
}

function limactl(args: readonly string[]): string {
  return commandOk("limactl", args);
}

function agentSh(script: string): string {
  return limactl(["shell", AGENT_VM_NAME, "--", "bash", "-lc", script]);
}

function firewallSh(script: string): string {
  return limactl(["shell", FIREWALL_VM_NAME, "--", "bash", "-lc", script]);
}

function yamlHasOverVsock(path: string): boolean {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inSsh = false;
  for (const line of lines) {
    if (line.startsWith("ssh:")) {
      inSsh = true;
      continue;
    }
    if (inSsh && /^[^ \t#]/.test(line)) {
      inSsh = false;
    }
    if (inSsh && /^[ \t]+overVsock:[ \t]+true[ \t]*$/.test(line)) {
      return true;
    }
  }
  return false;
}

function limaInstanceHasOverVsock(name: string): void {
  const out = limactl(["list", name, "--json"]);
  if (!out.includes('"overVsock":true')) {
    throw new TestFailure("overVsock was not true");
  }
}

function checkedInYamlsHaveOverVsock(): void {
  if (!yamlHasOverVsock(join(REPO_DIR, "nixos.yaml")) || !yamlHasOverVsock(join(REPO_DIR, "firewall.yaml"))) {
    throw new TestFailure("checked-in Lima YAML is missing ssh.overVsock: true");
  }
}

function syncDefaultAllowlists(): void {
  log("syncing .defaults allowlists into test firewall...");
  for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
    limactl([
      "cp",
      join(REPO_DIR, "proxy", `${file}.defaults`),
      `${FIREWALL_VM_NAME}:/etc/agent-vm/${file}`,
    ]);
  }
  runInherited("limactl", ["shell", FIREWALL_VM_NAME, "--", "sudo", "/etc/agent-vm/reload.sh"], {
    ignoredOutput: true,
  });
}

function agentRestartsViaWrapper(): void {
  limactl(["stop", AGENT_VM_NAME]);
  commandOk(join(REPO_DIR, "rootcell"), ["provision"]);
  syncDefaultAllowlists();
  limactl(["shell", AGENT_VM_NAME, "--", "true"]);
}

function denySniNoBypassWithInsecureCurl(): void {
  const result = runCapture("limactl", [
    "shell",
    AGENT_VM_NAME,
    "--",
    "bash",
    "-lc",
    "curl -sk --max-time 10 -o /dev/null -w \"%{size_download}\" https://pythonhosted.org",
  ], { allowFailure: true });
  const size = (result.stdout.trim() || "0");
  if (size !== "0") {
    throw new TestFailure(`deny path leaked: curl -k against denied SNI downloaded ${size} bytes`);
  }
}

function denySniNoMitmproxyCert(): void {
  const out = runCapture("limactl", [
    "shell",
    AGENT_VM_NAME,
    "--",
    "bash",
    "-lc",
    "curl -skv --max-time 10 -o /dev/null https://pythonhosted.org 2>&1 | grep -i issuer",
  ], { allowFailure: true }).stdout;
  if (/mitmproxy/i.test(out)) {
    throw new TestFailure(`denied SNI received a mitmproxy-issued cert: ${out}`);
  }
}

function allowedHttpsCertIsOurs(): void {
  const issuer = runCapture("limactl", [
    "shell",
    AGENT_VM_NAME,
    "--",
    "bash",
    "-lc",
    "curl -sSv --max-time 10 -o /dev/null https://github.com 2>&1 | grep -i \"issuer:\" | head -n1",
  ], { allowFailure: true }).stdout;
  if (!issuer.includes("agent-vm proxy CA")) {
    throw new TestFailure(`expected mitmproxy-minted cert (issuer=agent-vm proxy CA), got: ${issuer}`);
  }
}

function sniPinnedToUpstreamIdentity(): void {
  const out = runCapture("limactl", [
    "shell",
    AGENT_VM_NAME,
    "--",
    "bash",
    "-lc",
    "curl -sk --max-time 10 -D - --resolve github.com:443:1.1.1.1 https://github.com",
  ], { allowFailure: true }).stdout;
  if (out.length === 0) {
    return;
  }
  if (/^server: mitmproxy/im.test(out) && /Certificate verify failed: hostname mismatch/i.test(out)) {
    return;
  }
  throw new TestFailure(`MITM bypass: SNI=github.com routed to 1.1.1.1 returned unexpected response:\n${out.split(/\r?\n/).slice(0, 20).join("\n")}`);
}

function hostMustAgreeWithSni(): void {
  const code = runCapture("limactl", [
    "shell",
    AGENT_VM_NAME,
    "--",
    "bash",
    "-lc",
    "curl -sS --max-time 10 -o /dev/null -w \"%{http_code}\" -H \"Host: objects.githubusercontent.com\" https://api.github.com/",
  ], { allowFailure: true }).stdout.trim();
  if (code === "000" || code.length === 0) {
    return;
  }
  throw new TestFailure(`Host/SNI mismatch leaked: got HTTP ${code} from api.github.com with Host: objects.githubusercontent.com`);
}

function buildCases(): TestCase[] {
  return [
    { name: "checked-in Lima YAMLs force SSH over VSOCK", run: checkedInYamlsHaveOverVsock },
    { name: "agent VM is Running", run: () => commandOk("bash", ["-c", `[ "$(limactl list --format '{{.Status}}' ${AGENT_VM_NAME})" = Running ]`]) },
    { name: "firewall VM is Running", run: () => commandOk("bash", ["-c", `[ "$(limactl list --format '{{.Status}}' ${FIREWALL_VM_NAME})" = Running ]`]) },
    { name: "agent Lima config has ssh.overVsock enabled", run: () => { limaInstanceHasOverVsock(AGENT_VM_NAME); } },
    { name: "firewall Lima config has ssh.overVsock enabled", run: () => { limaInstanceHasOverVsock(FIREWALL_VM_NAME); } },
    { name: "agent Lima user has lingering enabled", run: () => agentSh('loginctl show-user "$USER" -p Linger | grep -q Linger=yes') },
    { name: "agent restarts via ./rootcell after locked-down networking", run: agentRestartsViaWrapper },
    { name: "firewall services active", run: () => firewallSh("systemctl is-active mitmproxy-explicit mitmproxy-transparent dnsmasq >/dev/null") },
    { name: "agent spy --help is wired", run: () => commandOk("bash", ["-c", `'${join(REPO_DIR, "rootcell")}' spy --help | grep -q -- '--tui'`]) },
    { name: "agent spy tui flags parse with help", run: () => commandOk("bash", ["-c", `'${join(REPO_DIR, "rootcell")}' spy --tui --raw --no-dedupe --help | grep -q -- '--tui'`]) },
    { name: "firewall spy formatter installed", run: () => firewallSh('test -x /etc/agent-vm/agent_spy.py && test -x /etc/agent-vm/agent_spy_tui.py && command -v python3 >/dev/null && python3 -c "import textual" && test -d /run/agent-vm-spy') },
    { name: "agent VM has test IP on enp0s1", run: () => agentSh(`ip -4 -o addr show enp0s1 | grep -q '${AGENT_IP}/'`) },
    { name: "agent VM has no default Lima usernet NIC", run: () => agentSh("! ip link show enp0s2 >/dev/null 2>&1") },
    { name: "agent VM routes default traffic through firewall", run: () => agentSh(`ip route show default | grep -q '^default via ${FIREWALL_IP} dev enp0s1'`) },
    { name: "agent VM has no direct usernet address", run: () => agentSh("! ip -4 -o addr show | grep -q '192\\.168\\.5\\.'") },
    { name: "firewall VM has test IP on enp0s2", run: () => firewallSh(`ip -4 -o addr show enp0s2 | grep -q '${FIREWALL_IP}/'`) },
    { name: "agent reaches firewall dnsmasq on private VMNET link", run: () => agentSh(`dig @${FIREWALL_IP} +short +time=5 +tries=1 github.com | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'`) },
    { name: "home-manager dev CLIs on PATH", run: () => agentSh("command -v pi && command -v rg && command -v gh && command -v jq >/dev/null") },
    { name: "pi --help runs", run: () => agentSh('out=$(pi --help) && [ -n "$out" ]') },
    { name: "HTTPS allowed: github.com", run: () => agentSh('code=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" https://github.com) && [[ "$code" =~ ^[23] ]]') },
    { name: "HTTP denied: even allowed host fails over cleartext (github.com:80)", run: () => { commandFails("limactl", ["shell", AGENT_VM_NAME, "--", "bash", "-lc", "curl -sS --max-time 5 -o /dev/null http://github.com"]); } },
    { name: "HTTPS denied via DNS: example.com (curl fails)", run: () => { commandFails("limactl", ["shell", AGENT_VM_NAME, "--", "bash", "-lc", "curl -sS --max-time 10 -o /dev/null https://example.com"]); } },
    { name: "HTTPS denied via SNI: pythonhosted.org (DNS-allowed, SNI-not-allowed)", run: () => { commandFails("limactl", ["shell", AGENT_VM_NAME, "--", "bash", "-lc", "curl -sS --max-time 10 -o /dev/null https://pythonhosted.org"]); } },
    { name: "HTTPS deny path: insecure curl (-k) yields no upstream bytes", run: denySniNoBypassWithInsecureCurl },
    { name: "HTTPS deny path: no mitmproxy-issued cert for denied SNI", run: denySniNoMitmproxyCert },
    { name: "HTTPS allowed: cert issuer is our deployment CA (proves MITM is on)", run: allowedHttpsCertIsOurs },
    { name: "HTTPS MITM: SNI-vs-upstream-IP mismatch denied", run: sniPinnedToUpstreamIdentity },
    { name: "HTTPS MITM: Host header must agree with SNI", run: hostMustAgreeWithSni },
    { name: "DNS allowed: github.com resolves to an IP", run: () => { agentSh('dig +short +time=5 +tries=1 github.com | grep -qE "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"'); } },
    { name: "DNS denied: example.com returns REFUSED", run: () => { agentSh('dig example.com +time=5 +tries=1 2>&1 | grep -q "status: REFUSED"'); } },
    { name: "SSH allowed: github.com (CONNECT succeeds)", run: () => agentSh('ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -T git@github.com 2>&1 | grep -qE "(successfully authenticated|Permission denied|does not provide shell)"') },
    { name: "SSH denied: 1.1.1.1 (ssh fails)", run: () => { commandFails("limactl", ["shell", AGENT_VM_NAME, "--", "bash", "-lc", "ssh -o BatchMode=yes -o ConnectTimeout=10 -T -p 22 root@1.1.1.1"]); } },
  ];
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

function preflightEnvCollision(): void {
  const envPath = join(REPO_DIR, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const envText = readFileSync(envPath, "utf8");
  if (new RegExp(`^(FIREWALL_IP=${escapeRegExp(FIREWALL_IP)}|AGENT_IP=${escapeRegExp(AGENT_IP)})$`, "m").test(envText)) {
    log(`your .env already uses the test IPs (${FIREWALL_IP} / ${AGENT_IP}).`);
    log("edit .env to use different prod IPs, or run --teardown.");
    process.exit(1);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main(args: readonly string[]): number {
  const parsed = parseArgs(args);
  process.env.AGENT_VM_NAME = AGENT_VM_NAME;
  process.env.FIREWALL_VM_NAME = FIREWALL_VM_NAME;
  process.env.FIREWALL_IP = FIREWALL_IP;
  process.env.AGENT_IP = AGENT_IP;

  preflightEnvCollision();

  if (parsed.teardown) {
    log("deleting test VMs...");
    runInherited("limactl", ["delete", "-f", AGENT_VM_NAME, FIREWALL_VM_NAME], {
      allowFailure: true,
      ignoredOutput: true,
    });
    return 0;
  }
  if (parsed.clean) {
    log("deleting test VMs for a fresh provision...");
    runInherited("limactl", ["delete", "-f", AGENT_VM_NAME, FIREWALL_VM_NAME], {
      allowFailure: true,
      ignoredOutput: true,
    });
  }

  log("provisioning test VMs (first run takes ~15 min)...");
  commandOk(join(REPO_DIR, "rootcell"), ["provision"]);
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
