import type { CommandResult, InheritedCommandResult } from "../types.ts";

export type VmRole = "agent" | "firewall";

export type VmStatus =
  | { readonly state: "missing" }
  | { readonly state: "running" }
  | { readonly state: "stopped" }
  | { readonly state: "unexpected"; readonly detail: string };

export interface GuestNetworkConfig {
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly networkPrefix: 24;
  readonly agentPrivateInterface: string;
  readonly firewallPrivateInterface: string;
  readonly firewallEgressInterface: string;
  readonly firewallControlInterface?: string;
}

export interface VmNetworkAttachment {
  readonly kind: string;
}

export interface NetworkPlan<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly provider: string;
  readonly guest: GuestNetworkConfig;
  readonly vms: Record<VmRole, TAttachment>;
}

export interface NetworkProvider<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly id: string;
  plan(): NetworkPlan<TAttachment>;
  preflight(): Promise<void>;
  ensureReady(input: {
    readonly affectedVms: readonly string[];
    readonly stopVmIfRunning: (name: string) => Promise<void>;
  }): Promise<void>;
}

export interface ExecOptions {
  readonly env?: readonly string[];
  readonly allowFailure?: boolean;
  readonly ignoredOutput?: boolean;
}

export interface CopyToGuestOptions {
  readonly recursive?: boolean;
}

export interface VmProvider<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly id: string;
  status(name: string): Promise<VmStatus>;
  forceStopIfRunning(name: string): Promise<void>;
  assertCompatible(name: string, network: TAttachment): Promise<void>;
  ensureRunning(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: TAttachment;
  }): Promise<{ readonly created: boolean }>;

  exec(name: string, command: readonly string[], options?: ExecOptions): Promise<InheritedCommandResult>;
  execCapture(name: string, command: readonly string[], options?: ExecOptions): Promise<CommandResult>;
  execInteractive(name: string, command: readonly string[], options?: ExecOptions): Promise<number>;
  copyToGuest(name: string, hostPath: string, guestPath: string, options?: CopyToGuestOptions): Promise<void>;
}

export interface ProviderBundle<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly network: NetworkProvider<TAttachment>;
  readonly vm: VmProvider<TAttachment>;
}
