import type { SpawnSyncReturns } from "node:child_process";

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
  readonly agentVm: string;
  readonly firewallVm: string;
  readonly guestUser: string;
  readonly guestRepoDir: string;
  readonly limaNetwork: string;
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly networkPrefix: string;
  readonly vmStartTimeout: string;
  readonly socketVmnetDst: string;
}

export interface ParsedRootcellArgs {
  readonly subcommand: RootcellSubcommand | "";
  readonly rest: readonly string[];
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

import type { RootcellSubcommand } from "./metadata.ts";
