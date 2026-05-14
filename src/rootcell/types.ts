import type { SpawnSyncReturns } from "node:child_process";
import type { RootcellSubcommand } from "./metadata.ts";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InheritedCommandResult {
  readonly status: number;
}

export interface RootcellConfig {
  readonly repoDir: string;
  readonly instanceName: string;
  readonly instanceDir: string;
  readonly envPath: string;
  readonly secretsPath: string;
  readonly proxyDir: string;
  readonly pkiDir: string;
  readonly generatedDir: string;
  readonly agentVm: string;
  readonly firewallVm: string;
  readonly guestUser: string;
  readonly guestRepoDir: string;
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly networkPrefix: string;
  readonly vmnetUuid: string;
  readonly vmnetSocketPath: string;
  readonly vmnetPidPath: string;
  readonly vmStartTimeout: string;
  readonly socketVmnetDst: string;
  readonly rootcellVmnetHelperSrc: string;
  readonly rootcellVmnetHelperDst: string;
}

export interface ParsedRootcellRunArgs {
  readonly kind: "run";
  readonly instanceName: string;
  readonly subcommand: RootcellSubcommand | "";
  readonly rest: readonly string[];
  readonly spyOptions: SpyOptions;
}

export interface ParsedRootcellHandledArgs {
  readonly kind: "handled";
  readonly status: number;
}

export type ParsedRootcellArgs = ParsedRootcellRunArgs | ParsedRootcellHandledArgs;

export interface InstanceState {
  readonly schemaVersion: 1;
  readonly vmnetUuid: string;
  readonly subnet: string;
  readonly networkPrefix: 24;
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly socketPath: string;
  readonly pidPath: string;
}

export interface RootcellInstance {
  readonly name: string;
  readonly dir: string;
  readonly envPath: string;
  readonly secretsPath: string;
  readonly proxyDir: string;
  readonly pkiDir: string;
  readonly generatedDir: string;
  readonly statePath: string;
  readonly state: InstanceState;
}

export interface SpyOptions {
  readonly raw: boolean;
  readonly dedupe: boolean;
  readonly tui: boolean;
}

export interface SecretMapping {
  readonly envName: string;
  readonly service: string;
}

export interface VmFileSet {
  readonly agent: readonly string[];
  readonly firewall: readonly string[];
}

export type SyncSpawnResult = SpawnSyncReturns<string>;
