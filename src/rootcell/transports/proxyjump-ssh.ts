import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAsyncInherited, runCapture, runInherited } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
import type { CopyToGuestOptions, ExecOptions } from "../providers/types.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { GuestTransport } from "./types.ts";

export interface ProxyJumpSshEndpoints {
  readonly firewallHost: string;
  readonly agentHost: string;
  readonly identityPath: string;
  readonly knownHostsPath: string;
}

export class ProxyJumpSshTransport implements GuestTransport {
  readonly id = "proxyjump-ssh";

  constructor(
    private readonly config: RootcellConfig,
    private readonly endpoints: () => ProxyJumpSshEndpoints,
  ) {}

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    const result = runInherited("ssh", [
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ], inheritOptions(options));
    return Promise.resolve(result);
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    const result = runCapture("ssh", [
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ], {
      allowFailure: options.allowFailure ?? false,
    });
    return Promise.resolve(result);
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await runAsyncInherited("ssh", [
      "-t",
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ]);
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    const alias = this.aliasFor(name);
    runInherited("scp", [
      "-F",
      this.writeSshConfig(),
      ...(options.recursive === true ? ["-r"] : []),
      hostPath,
      `${alias}:${guestPath}`,
    ]);
    return Promise.resolve();
  }

  forgetHostKey(name: string): void {
    const endpoints = this.endpoints();
    const host = name === this.config.firewallVm ? endpoints.firewallHost : name === this.config.agentVm ? endpoints.agentHost : null;
    if (host === null) {
      throw new Error(`unknown rootcell VM for SSH transport: ${name}`);
    }
    forgetKnownHost(endpoints.knownHostsPath, host);
  }

  private sshArgs(name: string): readonly string[] {
    return [
      "-F",
      this.writeSshConfig(),
      this.aliasFor(name),
    ];
  }

  private aliasFor(name: string): string {
    if (name === this.config.firewallVm) {
      return "rootcell-firewall";
    }
    if (name === this.config.agentVm) {
      return "rootcell-agent";
    }
    throw new Error(`unknown rootcell VM for SSH transport: ${name}`);
  }

  private writeSshConfig(): string {
    const endpoints = this.endpoints();
    const sshDir = join(this.config.instanceDir, "ssh");
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const controlDir = sshControlDir(this.config.instanceDir);
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    const path = join(sshDir, "config");
    const content = sshConfig({
      user: this.config.guestUser,
      firewallHost: endpoints.firewallHost,
      agentHost: endpoints.agentHost,
      identityPath: endpoints.identityPath,
      knownHostsPath: endpoints.knownHostsPath,
      controlPath: join(controlDir, "%C"),
    });
    writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    return path;
  }
}

export function forgetKnownHost(knownHostsPath: string, host: string): void {
  if (!existsSync(knownHostsPath)) {
    return;
  }
  const original = readFileSync(knownHostsPath, "utf8");
  const lines = original.split(/\r?\n/);
  const kept = lines.filter((line) => !knownHostsLineMatchesHost(line, host));
  if (kept.length === lines.length) {
    return;
  }
  writeFileSync(knownHostsPath, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
}

function knownHostsLineMatchesHost(line: string, host: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("|")) {
    return false;
  }
  const marker = trimmed.split(/\s+/, 1)[0];
  if (marker === undefined) {
    return false;
  }
  return marker.split(",").some((candidate) => candidate === host || candidate === `[${host}]:22`);
}

function inheritOptions(options: ExecOptions): { readonly allowFailure?: boolean; readonly ignoredOutput?: boolean } {
  return {
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    ...(options.ignoredOutput === undefined ? {} : { ignoredOutput: options.ignoredOutput }),
  };
}

export function sshConfig(input: {
  readonly user: string;
  readonly firewallHost: string;
  readonly agentHost: string;
  readonly identityPath: string;
  readonly knownHostsPath: string;
  readonly controlPath?: string;
}): string {
  const multiplexing = input.controlPath === undefined
    ? []
    : [
      "  ControlMaster auto",
      "  ControlPersist 60s",
      `  ControlPath ${input.controlPath}`,
    ];
  return [
    "Host rootcell-firewall",
    `  HostName ${input.firewallHost}`,
    `  User ${input.user}`,
    `  IdentityFile ${input.identityPath}`,
    `  UserKnownHostsFile ${input.knownHostsPath}`,
    ...multiplexing,
    "  StrictHostKeyChecking accept-new",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ConnectTimeout 5",
    "  LogLevel ERROR",
    "",
    "Host rootcell-agent",
    `  HostName ${input.agentHost}`,
    `  User ${input.user}`,
    "  ProxyJump rootcell-firewall",
    `  IdentityFile ${input.identityPath}`,
    `  UserKnownHostsFile ${input.knownHostsPath}`,
    ...multiplexing,
    "  StrictHostKeyChecking accept-new",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ConnectTimeout 5",
    "  LogLevel ERROR",
    "",
  ].join("\n");
}

function sshControlDir(instanceDir: string): string {
  const hash = createHash("sha256").update(instanceDir).digest("hex").slice(0, 16);
  return join("/tmp", `rootcell-ssh-${hash}`);
}

function remoteCommand(command: readonly string[], options: ExecOptions): string {
  const full = options.env === undefined || options.env.length === 0
    ? command
    : ["env", ...options.env, ...command];
  return full.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function guestTransportPath(config: RootcellConfig, ...parts: readonly string[]): string {
  return join(config.instanceDir, ...parts);
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
