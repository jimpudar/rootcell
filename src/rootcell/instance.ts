import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseSchema } from "./schema.ts";
import {
  InstanceStateSchema,
  RootcellInstanceSchema,
  type InstanceState,
  type RootcellInstance,
} from "./types.ts";

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_INSTANCE = "default";
const DEFAULT_POOL_START = "192.168.100.0";
const DEFAULT_POOL_END = "192.168.254.0";
const INSTANCE_NAME_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

interface InstancePaths {
  readonly name: string;
  readonly dir: string;
  readonly envPath: string;
  readonly secretsPath: string;
  readonly proxyDir: string;
  readonly pkiDir: string;
  readonly generatedDir: string;
  readonly statePath: string;
}

interface StateEntry {
  readonly name: string;
  readonly state: InstanceState;
}

export function validateInstanceName(name: string): string {
  if (!INSTANCE_NAME_RE.test(name)) {
    throw new Error(`invalid instance name '${name}' (use lowercase letters, digits, and dashes; no trailing dash; max 32 chars)`);
  }
  return name;
}

export function deriveVmNames(instanceName: string): { readonly agentVm: string; readonly firewallVm: string } {
  validateInstanceName(instanceName);
  if (instanceName === DEFAULT_INSTANCE) {
    return { agentVm: "agent", firewallVm: "firewall" };
  }
  return { agentVm: `agent-${instanceName}`, firewallVm: `firewall-${instanceName}` };
}

export function seedRootcellInstanceFiles(repoDir: string, instanceName: string, log: (message: string) => void): void {
  const paths = instancePaths(repoDir, instanceName);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.proxyDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.generatedDir, { recursive: true, mode: 0o700 });

  const legacyDefault = instanceName === DEFAULT_INSTANCE;
  seedFile(
    paths.envPath,
    legacyDefault && existsSync(join(repoDir, ".env")) ? join(repoDir, ".env") : join(repoDir, ".env.defaults"),
    log,
    `${instanceName} .env`,
  );
  seedFile(
    paths.secretsPath,
    legacyDefault && existsSync(join(repoDir, "secrets.env")) ? join(repoDir, "secrets.env") : join(repoDir, "secrets.env.defaults"),
    log,
    `${instanceName} secrets.env`,
  );

  for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
    const legacyLive = join(repoDir, "proxy", file);
    const defaults = `${legacyLive}.defaults`;
    const source = legacyDefault && existsSync(legacyLive) ? legacyLive : defaults;
    seedFile(join(paths.proxyDir, file), source, log, `${instanceName} proxy/${file}`);
  }

  const legacyPki = join(repoDir, "pki");
  const instanceCa = join(paths.pkiDir, "agent-vm-ca-cert.pem");
  if (legacyDefault && !existsSync(instanceCa) && existsSync(legacyPki)) {
    cpSync(legacyPki, paths.pkiDir, { recursive: true });
    chmodSync(paths.pkiDir, 0o700);
    log(`seeded ${instanceName} pki from legacy pki/`);
  }
}

export function loadRootcellInstance(repoDir: string, instanceName: string, env: NodeJS.ProcessEnv): RootcellInstance {
  const paths = instancePaths(repoDir, instanceName);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.generatedDir, { recursive: true, mode: 0o700 });
  const state = ensureInstanceState(repoDir, paths, env);
  return rootcellInstanceFromPaths(paths, state);
}

export function loadExistingRootcellInstance(repoDir: string, instanceName: string): RootcellInstance | null {
  const paths = instancePaths(repoDir, instanceName);
  if (!existsSync(paths.statePath)) {
    return null;
  }
  return rootcellInstanceFromPaths(paths, readState(paths.name, paths.statePath));
}

export function listRootcellVmInstanceNames(repoDir: string): readonly string[] {
  const root = join(repoDir, ".rootcell", "instances");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && INSTANCE_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => instanceHasVmState(repoDir, name))
    .sort();
}

function instanceHasVmState(repoDir: string, instanceName: string): boolean {
  const paths = instancePaths(repoDir, instanceName);
  const vmNames = deriveVmNames(instanceName);
  return existsSync(join(paths.dir, "vfkit", vmNames.agentVm))
    || existsSync(join(paths.dir, "vfkit", vmNames.firewallVm))
    || existsSync(join(paths.dir, "vfkit", "network"));
}

function rootcellInstanceFromPaths(paths: InstancePaths, state: InstanceState): RootcellInstance {
  return parseSchema(RootcellInstanceSchema, {
    name: paths.name,
    dir: paths.dir,
    envPath: paths.envPath,
    secretsPath: paths.secretsPath,
    proxyDir: paths.proxyDir,
    pkiDir: paths.pkiDir,
    generatedDir: paths.generatedDir,
    statePath: paths.statePath,
    state,
  }, `invalid rootcell instance for ${paths.name}`);
}

export function instancePaths(repoDir: string, instanceName: string): InstancePaths {
  const name = validateInstanceName(instanceName);
  const dir = join(repoDir, ".rootcell", "instances", name);
  return {
    name,
    dir,
    envPath: join(dir, ".env"),
    secretsPath: join(dir, "secrets.env"),
    proxyDir: join(dir, "proxy"),
    pkiDir: join(dir, "pki"),
    generatedDir: join(dir, "generated"),
    statePath: join(dir, "state.json"),
  };
}

function ensureInstanceState(repoDir: string, paths: InstancePaths, env: NodeJS.ProcessEnv): InstanceState {
  const existingEntries = readAllInstanceStates(repoDir);
  assertNoSubnetCollisions(existingEntries);

  if (existsSync(paths.statePath)) {
    const state = readState(paths.name, paths.statePath);
    writeStateIfChanged(paths.statePath, state);
    assertNoSubnetCollisions([
      ...existingEntries.filter((entry) => entry.name !== paths.name),
      { name: paths.name, state },
    ]);
    return state;
  }

  const requested = stateFromEnv(paths, env);
  const used = new Set(existingEntries.map((entry) => entry.state.subnet));
  const state = requested ?? allocateState(env, used);
  if (used.has(state.subnet)) {
    throw new Error(`subnet ${state.subnet}/24 is already allocated to another rootcell instance`);
  }
  writeStateIfChanged(paths.statePath, state);
  return state;
}

function seedFile(dest: string, source: string, log: (message: string) => void, label: string): void {
  if (existsSync(dest) || !existsSync(source)) {
    return;
  }
  copyFileSync(source, dest);
  log(`seeded ${label} from ${source}`);
}

function readAllInstanceStates(repoDir: string): StateEntry[] {
  const root = join(repoDir, ".rootcell", "instances");
  if (!existsSync(root)) {
    return [];
  }
  const entries: StateEntry[] = [];
  for (const name of readdirSync(root)) {
    if (!INSTANCE_NAME_RE.test(name)) {
      continue;
    }
    const paths = instancePaths(repoDir, name);
    if (!existsSync(paths.statePath)) {
      continue;
    }
    entries.push({ name, state: readState(name, paths.statePath) });
  }
  return entries;
}

function readState(name: string, path: string): InstanceState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read rootcell instance state for ${name}: ${message}`, { cause: error });
  }
  return validateState(name, raw);
}

function validateState(name: string, raw: unknown): InstanceState {
  const state = parseSchema(InstanceStateSchema, raw, `invalid rootcell instance state for ${name}`);
  validateSubnetAndHosts(state.subnet, state.firewallIp, state.agentIp, name);
  return state;
}

function stateFromEnv(paths: InstancePaths, env: NodeJS.ProcessEnv): InstanceState | null {
  const firewallIp = env.FIREWALL_IP;
  const agentIp = env.AGENT_IP;
  if (firewallIp === undefined && agentIp === undefined) {
    return null;
  }
  if (firewallIp === undefined || agentIp === undefined) {
    throw new Error("FIREWALL_IP and AGENT_IP must be set together");
  }
  const prefix = env.NETWORK_PREFIX ?? "24";
  if (prefix !== "24") {
    throw new Error("rootcell instance networks must use NETWORK_PREFIX=24");
  }
  const subnet = formatIpv4(subnet24(parseIpv4(firewallIp)));
  validateSubnetAndHosts(subnet, firewallIp, agentIp, paths.name);
  return baseState(subnet, firewallIp, agentIp);
}

function allocateState(env: NodeJS.ProcessEnv, used: ReadonlySet<string>): InstanceState {
  const { start, end } = poolFromEnv(env);
  for (let network = start; network <= end; network += 256) {
    const subnet = formatIpv4(network);
    if (used.has(subnet)) {
      continue;
    }
    const prefix = subnet.slice(0, subnet.lastIndexOf("."));
    return baseState(subnet, `${prefix}.2`, `${prefix}.3`);
  }
  throw new Error(`rootcell subnet pool is exhausted (${formatIpv4(start)}/24 through ${formatIpv4(end)}/24)`);
}

function baseState(subnet: string, firewallIp: string, agentIp: string): InstanceState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    subnet,
    networkPrefix: 24,
    firewallIp,
    agentIp,
  };
}

function poolFromEnv(env: NodeJS.ProcessEnv): { readonly start: number; readonly end: number } {
  const start = parseIpv4(env.ROOTCELL_SUBNET_POOL_START ?? DEFAULT_POOL_START);
  const end = parseIpv4(env.ROOTCELL_SUBNET_POOL_END ?? DEFAULT_POOL_END);
  if ((start & 0xff) !== 0 || (end & 0xff) !== 0) {
    throw new Error("ROOTCELL_SUBNET_POOL_START and ROOTCELL_SUBNET_POOL_END must be /24 network addresses ending in .0");
  }
  if (!isPrivateIpv4(start) || !isPrivateIpv4(end)) {
    throw new Error("rootcell subnet pool must use RFC1918 private IPv4 space");
  }
  if (start > end) {
    throw new Error("ROOTCELL_SUBNET_POOL_START must be lower than or equal to ROOTCELL_SUBNET_POOL_END");
  }
  return { start, end };
}

function assertNoSubnetCollisions(entries: readonly StateEntry[]): void {
  const bySubnet = new Map<string, string[]>();
  for (const entry of entries) {
    const names = bySubnet.get(entry.state.subnet) ?? [];
    names.push(entry.name);
    bySubnet.set(entry.state.subnet, names);
  }
  for (const [subnet, names] of bySubnet) {
    if (names.length > 1) {
      throw new Error(`subnet ${subnet}/24 is allocated to multiple rootcell instances: ${names.join(", ")}`);
    }
  }
}

function validateSubnetAndHosts(subnet: string, firewallIp: string, agentIp: string, name: string): void {
  const subnetInt = parseIpv4(subnet);
  const firewallInt = parseIpv4(firewallIp);
  const agentInt = parseIpv4(agentIp);
  if ((subnetInt & 0xff) !== 0) {
    throw new Error(`invalid rootcell subnet for ${name}: ${subnet} must end in .0`);
  }
  if (!isPrivateIpv4(subnetInt)) {
    throw new Error(`invalid rootcell subnet for ${name}: ${subnet}/24 is not private IPv4 space`);
  }
  if (subnet24(firewallInt) !== subnetInt || subnet24(agentInt) !== subnetInt) {
    throw new Error(`invalid rootcell subnet for ${name}: firewall and agent IPs must be inside ${subnet}/24`);
  }
  if ((firewallInt & 0xff) !== 2 || (agentInt & 0xff) !== 3) {
    throw new Error(`invalid rootcell subnet for ${name}: firewall must use .2 and agent must use .3`);
  }
}

function parseIpv4(value: string): number {
  const parts = value.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${value}`);
  }
  let output = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${value}`);
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      throw new Error(`invalid IPv4 address: ${value}`);
    }
    output = ((output << 8) | octet) >>> 0;
  }
  return output;
}

function formatIpv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

function subnet24(value: number): number {
  return (value & 0xffffff00) >>> 0;
}

function isPrivateIpv4(value: number): boolean {
  const first = (value >>> 24) & 0xff;
  const second = (value >>> 16) & 0xff;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function writeStateIfChanged(path: string, state: InstanceState): void {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return;
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}
