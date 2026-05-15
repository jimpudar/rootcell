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
import { z } from "zod";
import { resolveHostTool } from "./host-tools.ts";
import { runCapture, runInherited, runStdoutToFile } from "./process.ts";
import { NonEmptyStringSchema, parseSchema, PositiveSafeIntegerSchema } from "./schema.ts";
import type { RootcellConfig } from "./types.ts";

export const ROOTCELL_IMAGE_SCHEMA_VERSION = 1;
export const ROOTCELL_GUEST_API_VERSION = 1;
export const ROOTCELL_CLI_IMAGE_CONTRACT_VERSION = 1;
export const DEFAULT_IMAGE_MANIFEST_URL = "https://github.com/rootcell-ai/rootcell/releases/latest/download/manifest.json";

export const RootcellImageRoleSchema = z.enum(["agent", "firewall", "builder"]);
export type RootcellImageRole = z.infer<typeof RootcellImageRoleSchema>;

export const RootcellImageCompressionSchema = z.enum(["zstd", "none"]);
export type RootcellImageCompression = z.infer<typeof RootcellImageCompressionSchema>;

const RootcellImageContractSchema = z.object({
  min: PositiveSafeIntegerSchema,
  max: PositiveSafeIntegerSchema,
}).refine((contract) => contract.min <= contract.max, {
  message: "rootcellCliContract min must be <= max",
});

export const RootcellImageEntrySchema = z.object({
  role: RootcellImageRoleSchema,
  architecture: z.literal("aarch64-linux"),
  fileName: NonEmptyStringSchema.optional(),
  url: NonEmptyStringSchema,
  compression: RootcellImageCompressionSchema.default("zstd"),
  compressedSize: PositiveSafeIntegerSchema,
  rawSize: PositiveSafeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256 digest"),
});

export type RootcellImageEntry = Readonly<z.infer<typeof RootcellImageEntrySchema>>;

export const RootcellImageManifestSchema = z.object({
  schemaVersion: z.literal(ROOTCELL_IMAGE_SCHEMA_VERSION),
  guestApiVersion: z.literal(ROOTCELL_GUEST_API_VERSION),
  rootcellSourceRevision: NonEmptyStringSchema,
  nixpkgsRevision: NonEmptyStringSchema,
  rootcellCliContract: RootcellImageContractSchema,
  images: z.array(RootcellImageEntrySchema).min(1, "must be a non-empty array"),
});

type RootcellImageManifestOutput = z.infer<typeof RootcellImageManifestSchema>;

export type RootcellImageManifest = Readonly<
  Omit<RootcellImageManifestOutput, "rootcellCliContract" | "images"> & {
    readonly rootcellCliContract: Readonly<RootcellImageManifestOutput["rootcellCliContract"]>;
    readonly images: readonly RootcellImageEntry[];
  }
>;

export class ImageStore {
  private zstdBin = "";

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
      runStdoutToFile(this.ensureZstd(), ["-d", "-c", compressedPath], tmp);
    } else {
      runInherited("cp", [compressedPath, tmp]);
    }
    renameSync(tmp, rawPath);
  }

  private ensureZstd(): string {
    if (this.zstdBin.length > 0) {
      return this.zstdBin;
    }
    this.zstdBin = resolveHostTool({
      name: "zstd",
      envVar: "ROOTCELL_ZSTD",
      purpose: "to expand downloaded rootcell VM images",
    });
    return this.zstdBin;
  }
}

export function parseRootcellImageManifest(raw: unknown): RootcellImageManifest {
  const manifest = parseSchema(RootcellImageManifestSchema, raw, "invalid rootcell image manifest");
  if (
    ROOTCELL_CLI_IMAGE_CONTRACT_VERSION < manifest.rootcellCliContract.min
    || ROOTCELL_CLI_IMAGE_CONTRACT_VERSION > manifest.rootcellCliContract.max
  ) {
    throw new Error("incompatible rootcell image manifest: CLI image contract is not supported");
  }
  return manifest;
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
