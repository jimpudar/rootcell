import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { runCapture, runInherited, runStdoutToFile } from "./process.ts";
import type { RootcellConfig } from "./types.ts";

export const ROOTCELL_IMAGE_SCHEMA_VERSION = 1;
export const ROOTCELL_GUEST_API_VERSION = 1;
export const ROOTCELL_CLI_IMAGE_CONTRACT_VERSION = 1;
export const DEFAULT_IMAGE_MANIFEST_URL = "https://github.com/jimpudar/rootcell-images/releases/latest/download/manifest.json";

export type RootcellImageRole = "agent" | "firewall" | "builder";
export type RootcellImageCompression = "zstd" | "none";

export interface RootcellImageManifest {
  readonly schemaVersion: 1;
  readonly guestApiVersion: 1;
  readonly rootcellSourceRevision: string;
  readonly nixpkgsRevision: string;
  readonly rootcellCliContract: {
    readonly min: number;
    readonly max: number;
  };
  readonly images: readonly RootcellImageEntry[];
}

export interface RootcellImageEntry {
  readonly role: RootcellImageRole;
  readonly architecture: "aarch64-linux";
  readonly fileName?: string;
  readonly url: string;
  readonly compression: RootcellImageCompression;
  readonly compressedSize: number;
  readonly rawSize: number;
  readonly sha256: string;
}

interface LocalBuilderState {
  readonly provider: "vfkit";
  readonly role: "builder";
  readonly pid: number;
  readonly controlMac: string;
  readonly controlIp: string;
  readonly diskPath: string;
  readonly efiVariableStorePath: string;
  readonly restSocketPath: string;
  readonly logPath: string;
}

export class ImageStore {
  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {}

  ensureRoleImage(role: RootcellImageRole): string {
    const manifest = this.loadManifest();
    const entry = imageForRole(manifest, role);
    const cacheDir = join(imageCacheRoot(), entry.sha256);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const rawPath = join(cacheDir, `${role}.raw`);
    if (existsSync(rawPath)) {
      return rawPath;
    }

    const compressedPath = join(cacheDir, entry.fileName ?? basename(entry.url));
    this.ensureCompressed(entry, compressedPath);
    const actual = sha256File(compressedPath);
    if (actual !== entry.sha256) {
      throw new Error(`image digest mismatch for ${role}: expected ${entry.sha256}, got ${actual}`);
    }
    this.expandImage(entry, compressedPath, rawPath);
    return rawPath;
  }

  loadManifest(): RootcellImageManifest {
    const manifest = this.config.imageDir === undefined
      ? JSON.parse(runCapture("curl", ["-fsSL", this.config.imageManifestUrl]).stdout) as unknown
      : JSON.parse(readFileSync(join(this.config.imageDir, "manifest.json"), "utf8")) as unknown;
    return parseRootcellImageManifest(manifest);
  }

  private ensureCompressed(entry: RootcellImageEntry, path: string): void {
    if (existsSync(path)) {
      return;
    }
    if (this.config.imageDir !== undefined) {
      const source = join(this.config.imageDir, entry.fileName ?? basename(entry.url));
      if (!existsSync(source)) {
        throw new Error(`image artifact not found for ${entry.role}: ${source}`);
      }
      runInherited("cp", [source, path]);
      return;
    }
    this.log(`downloading ${entry.role} rootcell image...`);
    const tmp = `${path}.tmp`;
    runInherited("curl", ["-fL", "-o", tmp, imageDownloadUrl(entry.url, this.config.imageManifestUrl)]);
    renameSync(tmp, path);
  }

  private expandImage(entry: RootcellImageEntry, compressedPath: string, rawPath: string): void {
    const tmp = `${rawPath}.tmp`;
    if (entry.compression === "zstd") {
      runStdoutToFile("zstd", ["-d", "-c", compressedPath], tmp);
    } else {
      runInherited("cp", [compressedPath, tmp]);
    }
    renameSync(tmp, rawPath);
  }
}

export function parseRootcellImageManifest(raw: unknown): RootcellImageManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid rootcell image manifest: expected object");
  }
  const record = raw as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  const guestApiVersion = record.guestApiVersion;
  if (schemaVersion !== ROOTCELL_IMAGE_SCHEMA_VERSION) {
    throw new Error("incompatible rootcell image manifest: unsupported schemaVersion");
  }
  if (guestApiVersion !== ROOTCELL_GUEST_API_VERSION) {
    throw new Error(`incompatible rootcell image manifest: guestApiVersion ${String(guestApiVersion)} is not supported`);
  }
  const rootcellSourceRevision = stringField(record, "rootcellSourceRevision");
  const nixpkgsRevision = stringField(record, "nixpkgsRevision");
  const rootcellCliContract = parseContract(record.rootcellCliContract);
  if (
    ROOTCELL_CLI_IMAGE_CONTRACT_VERSION < rootcellCliContract.min
    || ROOTCELL_CLI_IMAGE_CONTRACT_VERSION > rootcellCliContract.max
  ) {
    throw new Error("incompatible rootcell image manifest: CLI image contract is not supported");
  }
  const imagesRaw = record.images;
  if (!Array.isArray(imagesRaw) || imagesRaw.length === 0) {
    throw new Error("invalid rootcell image manifest: images must be a non-empty array");
  }
  return {
    schemaVersion: ROOTCELL_IMAGE_SCHEMA_VERSION,
    guestApiVersion: ROOTCELL_GUEST_API_VERSION,
    rootcellSourceRevision,
    nixpkgsRevision,
    rootcellCliContract,
    images: imagesRaw.map(parseImageEntry),
  };
}

export function imageForRole(manifest: RootcellImageManifest, role: RootcellImageRole): RootcellImageEntry {
  const entry = manifest.images.find((image) => image.role === role);
  if (entry === undefined) {
    throw new Error(`rootcell image manifest does not contain an aarch64-linux ${role} image`);
  }
  return entry;
}

export function imageCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, "rootcell", "images");
  }
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0) {
    return join(home, ".cache", "rootcell", "images");
  }
  return join("/tmp", "rootcell", "images");
}

export function imageDownloadUrl(entryUrl: string, manifestUrl: string): string {
  return new URL(entryUrl, manifestUrl).toString();
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function buildLocalImages(config: RootcellConfig, log: (message: string) => void): number {
  const imagesDir = join(config.repoDir, ".rootcell", "images");
  mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
  const direct = runInherited("nix", [
    "build",
    "--print-build-logs",
    "--out-link",
    join(imagesDir, "dist"),
    `${config.repoDir}#packages.aarch64-linux.rootcellImages`,
  ], { allowFailure: true }).status;
  if (direct === 0) {
    return 0;
  }

  log("direct aarch64-linux image build failed; starting local vfkit Linux builder...");
  buildLocalImagesWithBuilder(config, log);
  return 0;
}

export function builderVfkitArgs(input: {
  readonly diskPath: string;
  readonly efiVariableStorePath: string;
  readonly restSocketPath: string;
  readonly logPath: string;
  readonly cloudInitDir: string;
  readonly controlMac: string;
}): readonly string[] {
  return [
    "--cpus", "4",
    "--memory", "8192",
    "--bootloader", `efi,variable-store=${input.efiVariableStorePath},create`,
    "--restful-uri", `unix://${input.restSocketPath}`,
    "--device", `virtio-blk,path=${input.diskPath}`,
    "--device", `virtio-serial,logFilePath=${input.logPath}`,
    "--device", "virtio-rng",
    "--device", "virtio-balloon",
    "--device", `virtio-net,nat,mac=${input.controlMac}`,
    "--cloud-init", `${join(input.cloudInitDir, "user-data")},${join(input.cloudInitDir, "meta-data")}`,
  ];
}

function buildLocalImagesWithBuilder(config: RootcellConfig, log: (message: string) => void): void {
  const builder = new LocalVfkitImageBuilder(config, log);
  const host = builder.ensureRunning();
  builder.buildImages(host);
}

class LocalVfkitImageBuilder {
  private vfkitBin = process.env.ROOTCELL_VFKIT ?? "";
  private readonly builderDir: string;
  private readonly keyPath: string;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {
    this.builderDir = join(config.repoDir, ".rootcell", "images", "builder");
    this.keyPath = join(this.builderDir, "ssh", "rootcell_builder_ed25519");
  }

  ensureRunning(): string {
    mkdirSync(this.builderDir, { recursive: true, mode: 0o700 });
    this.ensureVfkit();
    this.ensureControlKey();
    let state = this.readState();
    if (state !== null && processIsRunning(state.pid)) {
      this.waitForSsh(state.controlIp);
      return state.controlIp;
    }

    this.log("booting local vfkit Linux builder VM...");
    this.prepareDisk();
    const controlMac = macFor("rootcell-images-builder");
    const cloudInitDir = this.writeCloudInit();
    const args = builderVfkitArgs({
      diskPath: this.diskPath(),
      efiVariableStorePath: this.efiVariableStorePath(),
      restSocketPath: this.restSocketPath(),
      logPath: this.logPath(),
      cloudInitDir,
      controlMac,
    });
    const child = spawn(this.vfkitBin, args, { detached: true, stdio: "ignore" });
    if (child.pid === undefined) {
      throw new Error("vfkit did not report a pid for the image builder");
    }
    child.unref();
    const controlIp = this.waitForControlIp(controlMac);
    state = {
      provider: "vfkit",
      role: "builder",
      pid: child.pid,
      controlMac,
      controlIp,
      diskPath: this.diskPath(),
      efiVariableStorePath: this.efiVariableStorePath(),
      restSocketPath: this.restSocketPath(),
      logPath: this.logPath(),
    };
    this.writeState(state);
    this.waitForSsh(controlIp);
    return controlIp;
  }

  buildImages(host: string): void {
    this.log("building rootcell raw images through vfkit Nix remote builder...");
    const dist = join(this.config.repoDir, ".rootcell", "images", "dist");
    rmSync(dist, { recursive: true, force: true });
    const sshConfigPath = this.writeNixSshConfig(host);
    runInherited("nix", [
      "build",
      "--print-build-logs",
      "--max-jobs", "0",
      "--option", "builders",
      "ssh-ng://rootcell-image-builder aarch64-linux - 4 1 kvm,big-parallel,nixos-test - -",
      "--option", "builders-use-substitutes", "true",
      "--out-link", dist,
      `${this.config.repoDir}#packages.aarch64-linux.rootcellImages`,
    ], {
      env: {
        ...process.env,
        NIX_SSHOPTS: `-F ${sshConfigPath}`,
      },
    });
  }

  private prepareDisk(): void {
    const disk = this.diskPath();
    if (existsSync(disk)) {
      return;
    }
    const base = new ImageStore(this.config, this.log).ensureRoleImage("builder");
    const clone = runInherited("cp", ["-c", base, disk], { allowFailure: true, ignoredOutput: true });
    if (clone.status !== 0) {
      runInherited("cp", [base, disk]);
    }
    runInherited("truncate", ["-s", "120G", disk]);
  }

  private ensureVfkit(): void {
    if (this.vfkitBin.length > 0) {
      return;
    }
    const result = runCapture("nix", [
      "build",
      "--no-link",
      "--print-out-paths",
      `${this.config.repoDir}#vfkit`,
    ], { allowFailure: true });
    if (result.status !== 0) {
      throw new Error(`failed to build vfkit from ${this.config.repoDir}/flake.nix:\n${result.stderr}`);
    }
    this.vfkitBin = join(firstToken(result.stdout), "bin/vfkit");
  }

  private ensureControlKey(): void {
    if (existsSync(this.keyPath) && existsSync(`${this.keyPath}.pub`)) {
      return;
    }
    mkdirSync(join(this.builderDir, "ssh"), { recursive: true, mode: 0o700 });
    runInherited("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "rootcell-image-builder", "-f", this.keyPath]);
  }

  private writeCloudInit(): string {
    const dir = join(this.builderDir, "cloud-init");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const publicKey = readFileSync(`${this.keyPath}.pub`, "utf8").trim();
    writeFileSync(join(dir, "meta-data"), [
      "instance-id: rootcell-image-builder",
      "local-hostname: rootcell-image-builder",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "user-data"), [
      "#cloud-config",
      "ssh_pwauth: false",
      "disable_root: true",
      "users:",
      "  - name: luser",
      "    groups: [wheel, users]",
      "    shell: /run/current-system/sw/bin/bash",
      "    sudo: ALL=(ALL) NOPASSWD:ALL",
      "    ssh_authorized_keys:",
      `      - ${publicKey}`,
      "",
    ].join("\n"), "utf8");
    return dir;
  }

  private waitForControlIp(controlMac: string): string {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const leaseIp = lookupDhcpLease(controlMac, undefined, "rootcell-image-builder");
      if (leaseIp !== null && arpHasIp(leaseIp)) {
        return leaseIp;
      }
      const arpIp = lookupArpIpByMac(controlMac);
      if (arpIp !== null) {
        return arpIp;
      }
      Bun.sleepSync(500);
    }
    throw new Error(`timeout waiting for DHCP lease for builder MAC ${controlMac}`);
  }

  private waitForSsh(host: string): void {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = runInherited("ssh", [...this.sshOptions(host), "true"], {
        allowFailure: true,
        ignoredOutput: true,
      });
      if (result.status === 0) {
        return;
      }
      Bun.sleepSync(500);
    }
    throw new Error(`timeout waiting for SSH to rootcell image builder at ${host}`);
  }

  private sshOptions(host: string): readonly string[] {
    return [
      "-i", this.keyPath,
      "-o", `UserKnownHostsFile=${join(this.builderDir, "known_hosts")}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=5",
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=3",
      `luser@${host}`,
    ];
  }

  private writeNixSshConfig(host: string): string {
    const path = join(this.builderDir, "nix-ssh-config");
    writeFileSync(path, [
      "Host rootcell-image-builder",
      `  HostName ${host}`,
      "  User luser",
      `  IdentityFile ${this.keyPath}`,
      `  UserKnownHostsFile ${join(this.builderDir, "known_hosts")}`,
      "  StrictHostKeyChecking accept-new",
      "  ConnectTimeout 5",
      "  ServerAliveInterval 10",
      "  ServerAliveCountMax 3",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private readState(): LocalBuilderState | null {
    const path = this.statePath();
    if (!existsSync(path)) {
      return null;
    }
    try {
      return parseLocalBuilderState(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      return null;
    }
  }

  private writeState(state: LocalBuilderState): void {
    writeFileSync(this.statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private diskPath(): string {
    return join(this.builderDir, "disk.raw");
  }

  private efiVariableStorePath(): string {
    return join(this.builderDir, "efi-variable-store");
  }

  private restSocketPath(): string {
    return join(this.builderDir, "vfkit-rest.sock");
  }

  private logPath(): string {
    return join(this.builderDir, "serial.log");
  }

  private statePath(): string {
    return join(this.builderDir, "state.json");
  }
}

function parseLocalBuilderState(raw: unknown): LocalBuilderState {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid local image builder state: expected object");
  }
  const record = raw as Record<string, unknown>;
  if (record.provider !== "vfkit" || record.role !== "builder") {
    throw new Error("invalid local image builder state: provider or role mismatch");
  }
  return {
    provider: "vfkit",
    role: "builder",
    pid: stateNumberField(record, "pid"),
    controlMac: stateStringField(record, "controlMac"),
    controlIp: stateStringField(record, "controlIp"),
    diskPath: stateStringField(record, "diskPath"),
    efiVariableStorePath: stateStringField(record, "efiVariableStorePath"),
    restSocketPath: stateStringField(record, "restSocketPath"),
    logPath: stateStringField(record, "logPath"),
  };
}

function lookupDhcpLease(mac: string, leasesPath = "/var/db/dhcpd_leases", fallbackName?: string): string | null {
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

function arpHasIp(ip: string): boolean {
  const output = runCapture("arp", ["-an"], { allowFailure: true }).stdout;
  return output.split(/\r?\n/).some((line) => line.includes(`(${ip})`) && line.includes(" at ") && !line.includes("(incomplete)"));
}

function normalizeMac(mac: string): string {
  return mac.toLowerCase().split(":").map((part) => part.replace(/^0([0-9a-f])$/, "$1")).join(":");
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

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function macFor(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  return `02:${Array.from(hash.subarray(0, 5), (value) => value.toString(16).padStart(2, "0"))
    .join(":")}`;
}

function firstToken(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) {
    throw new Error("command produced no output");
  }
  return token;
}

function stateStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid local image builder state: ${field} must be a non-empty string`);
  }
  return value;
}

function stateNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid local image builder state: ${field} must be a positive integer`);
  }
  return value;
}

function parseImageEntry(raw: unknown): RootcellImageEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid rootcell image manifest: image entries must be objects");
  }
  const record = raw as Record<string, unknown>;
  const role = roleField(record.role);
  const architecture = record.architecture;
  if (architecture !== "aarch64-linux") {
    throw new Error(`invalid rootcell image manifest: unsupported architecture for ${role}`);
  }
  const compression = compressionField(record.compression);
  return {
    role,
    architecture,
    ...(record.fileName === undefined ? {} : { fileName: stringField(record, "fileName") }),
    url: stringField(record, "url"),
    compression,
    compressedSize: positiveNumberField(record, "compressedSize"),
    rawSize: positiveNumberField(record, "rawSize"),
    sha256: sha256Field(record.sha256),
  };
}

function parseContract(raw: unknown): RootcellImageManifest["rootcellCliContract"] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid rootcell image manifest: rootcellCliContract must be an object");
  }
  const record = raw as Record<string, unknown>;
  const min = positiveNumberField(record, "min");
  const max = positiveNumberField(record, "max");
  if (min > max) {
    throw new Error("invalid rootcell image manifest: rootcellCliContract min must be <= max");
  }
  return { min, max };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid rootcell image manifest: ${field} must be a non-empty string`);
  }
  return value;
}

function positiveNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid rootcell image manifest: ${field} must be a positive integer`);
  }
  return value;
}

function roleField(value: unknown): RootcellImageRole {
  if (value === "agent" || value === "firewall" || value === "builder") {
    return value;
  }
  throw new Error("invalid rootcell image manifest: unsupported image role");
}

function compressionField(value: unknown): RootcellImageCompression {
  if (value === undefined || value === "zstd") {
    return "zstd";
  }
  if (value === "none") {
    return "none";
  }
  throw new Error("invalid rootcell image manifest: unsupported image compression");
}

function sha256Field(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("invalid rootcell image manifest: sha256 must be a lowercase hex SHA-256 digest");
  }
  return value;
}
