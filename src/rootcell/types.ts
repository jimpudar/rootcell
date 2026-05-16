import type { SpawnSyncReturns } from "node:child_process";
import { z } from "zod";
import { isRootcellSubcommand, type RootcellSubcommand } from "./metadata.ts";
import {
  EnvironmentVariableNameSchema,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
} from "./schema.ts";

export const CommandResultSchema = z.object({
  status: NonNegativeSafeIntegerSchema,
  stdout: z.string(),
  stderr: z.string(),
});

export type CommandResult = Readonly<z.infer<typeof CommandResultSchema>>;

export const InheritedCommandResultSchema = z.object({
  status: NonNegativeSafeIntegerSchema,
});

export type InheritedCommandResult = Readonly<z.infer<typeof InheritedCommandResultSchema>>;

export const RootcellConfigSchema = z.object({
  repoDir: NonEmptyStringSchema,
  instanceName: NonEmptyStringSchema,
  instanceDir: NonEmptyStringSchema,
  envPath: NonEmptyStringSchema,
  secretsPath: NonEmptyStringSchema,
  proxyDir: NonEmptyStringSchema,
  pkiDir: NonEmptyStringSchema,
  generatedDir: NonEmptyStringSchema,
  agentVm: NonEmptyStringSchema,
  firewallVm: NonEmptyStringSchema,
  guestUser: NonEmptyStringSchema,
  guestRepoDir: NonEmptyStringSchema,
  firewallIp: NonEmptyStringSchema,
  agentIp: NonEmptyStringSchema,
  networkPrefix: NonEmptyStringSchema,
  imageManifestUrl: NonEmptyStringSchema,
  imageDir: NonEmptyStringSchema.optional(),
});

export type RootcellConfig = Readonly<z.infer<typeof RootcellConfigSchema>>;

export const SpyOptionsSchema = z.object({
  raw: z.boolean(),
  dedupe: z.boolean(),
  tui: z.boolean(),
});

export type SpyOptions = Readonly<z.infer<typeof SpyOptionsSchema>>;

const RootcellSubcommandOrEmptySchema = z.custom<RootcellSubcommand | "">(
  (value) => value === "" || (typeof value === "string" && isRootcellSubcommand(value)),
  { message: "must be a rootcell subcommand" },
);

export const ParsedRootcellRunArgsSchema = z.object({
  kind: z.literal("run"),
  instanceName: NonEmptyStringSchema,
  subcommand: RootcellSubcommandOrEmptySchema,
  rest: z.array(z.string()),
  spyOptions: SpyOptionsSchema,
});

type ParsedRootcellRunArgsOutput = z.infer<typeof ParsedRootcellRunArgsSchema>;

export type ParsedRootcellRunArgs = Readonly<
  Omit<ParsedRootcellRunArgsOutput, "rest" | "spyOptions"> & {
    readonly rest: readonly string[];
    readonly spyOptions: SpyOptions;
  }
>;

export const ParsedRootcellHandledArgsSchema = z.object({
  kind: z.literal("handled"),
  status: NonNegativeSafeIntegerSchema,
});

export type ParsedRootcellHandledArgs = Readonly<z.infer<typeof ParsedRootcellHandledArgsSchema>>;

export const ParsedRootcellArgsSchema = z.discriminatedUnion("kind", [
  ParsedRootcellRunArgsSchema,
  ParsedRootcellHandledArgsSchema,
]);

export type ParsedRootcellArgs = ParsedRootcellRunArgs | ParsedRootcellHandledArgs;

export const InstanceStateSchema = z.object({
  schemaVersion: z.literal(1),
  subnet: NonEmptyStringSchema,
  networkPrefix: z.literal(24),
  firewallIp: NonEmptyStringSchema,
  agentIp: NonEmptyStringSchema,
});

export type InstanceState = Readonly<z.infer<typeof InstanceStateSchema>>;

export const SecretMappingSchema = z.object({
  envName: EnvironmentVariableNameSchema,
  service: NonEmptyStringSchema,
});

export type SecretMapping = Readonly<z.infer<typeof SecretMappingSchema>>;

export const RootcellInstanceSchema = z.object({
  name: NonEmptyStringSchema,
  dir: NonEmptyStringSchema,
  envPath: NonEmptyStringSchema,
  secretsPath: NonEmptyStringSchema,
  proxyDir: NonEmptyStringSchema,
  pkiDir: NonEmptyStringSchema,
  generatedDir: NonEmptyStringSchema,
  statePath: NonEmptyStringSchema,
  state: InstanceStateSchema,
});

type RootcellInstanceOutput = z.infer<typeof RootcellInstanceSchema>;

export type RootcellInstance = Readonly<
  Omit<RootcellInstanceOutput, "state"> & {
    readonly state: InstanceState;
  }
>;

export interface VmFileSet {
  readonly agent: readonly string[];
  readonly firewall: readonly string[];
}

export type SyncSpawnResult = SpawnSyncReturns<string>;
