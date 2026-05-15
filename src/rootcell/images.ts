import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
} from "node:fs";
import { basename, join } from "node:path";
import { runCapture, runInherited, runStdoutToFile } from "./process.ts";
import type { RootcellConfig } from "./types.ts";

export const ROOTCELL_IMAGE_SCHEMA_VERSION = 1;
export const ROOTCELL_GUEST_API_VERSION = 1;
export const ROOTCELL_CLI_IMAGE_CONTRACT_VERSION = 1;
export const DEFAULT_IMAGE_MANIFEST_URL = "https://github.com/rootcell-ai/rootcell/releases/latest/download/manifest.json";

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
