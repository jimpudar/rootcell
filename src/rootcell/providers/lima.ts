import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nixString } from "../env.ts";
import { runAsyncInherited, runCapture, runInherited } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { CopyToGuestOptions, ExecOptions, VmProvider, VmRole, VmStatus } from "./types.ts";
import type { LimaSocketNetworkAttachment } from "./macos-socket-vmnet.ts";

export class LimaVmProvider implements VmProvider<LimaSocketNetworkAttachment> {
  readonly id = "lima";
  private limaBin: string;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {
    this.limaBin = process.env.LIMACTL ?? "";
  }

  status(name: string): Promise<VmStatus> {
    return Promise.resolve(limaStatusFromOutput(this.limactlCapture(["list", "--format", "{{.Status}}", name], true).stdout));
  }

  async forceStopIfRunning(name: string): Promise<void> {
    if ((await this.status(name)).state === "running") {
      this.log(`force-stopping ${name} VM to repair stale ${this.config.instanceName} vmnet daemon...`);
      this.limactlInherited(["stop", "--force", name]);
    }
  }

  async assertCompatible(name: string, network: LimaSocketNetworkAttachment): Promise<void> {
    const status = await this.status(name);
    if (status.state === "missing") {
      return;
    }
    if (this.vmUsesInstanceSocket(name, network.socketPath)) {
      return;
    }
    this.log(`${name} exists but was not created for rootcell instance '${this.config.instanceName}'.`);
    this.log(`Delete and recreate it to migrate to the isolated socket vmnet network: limactl delete ${name} --force`);
    process.exit(1);
  }

  async ensureRunning(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: LimaSocketNetworkAttachment;
  }): Promise<{ readonly created: boolean }> {
    const configPath = join(this.config.repoDir, input.role === "agent" ? "nixos.yaml" : "firewall.yaml");
    const status = await this.status(input.name);
    switch (status.state) {
      case "running":
        return { created: false };
      case "stopped":
        this.log(`starting ${input.name} VM...`);
        this.startVm(input.name);
        return { created: false };
      case "missing":
        this.log(`${input.name} VM not found; creating (~3-5 min for image + boot)...`);
        {
          const result = this.limactlInherited([
            "start",
            "--timeout",
            this.config.vmStartTimeout,
            "--tty=false",
            `--name=${input.name}`,
            "--set",
            `.user.name = "${this.config.guestUser}"`,
            "--set",
            `.networks[0].socket = ${nixString(input.network.socketPath)}`,
            "--set",
            ".ssh.overVsock = true",
            configPath,
          ], { allowFailure: true });
          if (result.status !== 0) {
            this.diagnoseStartFailure(input.name);
            this.log(`limactl start ${input.name} failed; aborting.`);
            process.exit(1);
          }
        }
        return { created: true };
      case "unexpected":
        this.log(`${input.name} VM in unexpected state: '${status.detail}'. Aborting.`);
        process.exit(1);
    }
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    return Promise.resolve(this.limactlInherited(["shell", name, "--", ...guestCommand(command, options)], options));
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    return Promise.resolve(this.limactlCapture(["shell", name, "--", ...guestCommand(command, options)], options.allowFailure ?? false));
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await this.limactlAsyncInherited(["shell", name, "--", ...guestCommand(command, options)]);
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    this.limactlInherited([
      "cp",
      ...(options.recursive === true ? ["-r"] : []),
      hostPath,
      `${name}:${guestPath}`,
    ]);
    return Promise.resolve();
  }

  private ensureLima(): void {
    if (this.limaBin.length > 0) {
      return;
    }
    const result = runCapture("nix", [
      "build",
      "--no-link",
      "--print-out-paths",
      `${this.config.repoDir}#lima`,
    ], { allowFailure: true });
    if (result.status !== 0) {
      this.log(`failed to build repo-patched Lima from ${this.config.repoDir}/flake.nix:`);
      process.stderr.write(prefixLines(result.stderr, "rootcell:   "));
      process.exit(1);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    this.limaBin = join(firstToken(result.stdout), "bin/limactl");
  }

  private limaEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      LIMA_DISABLE_DEFAULT_USERNET_FOR_VSOCK: this.config.agentVm,
    };
  }

  private limactlCapture(args: readonly string[], allowFailure = false): ReturnType<typeof runCapture> {
    this.ensureLima();
    return runCapture(this.limaBin, args, {
      env: this.limaEnv(),
      allowFailure,
    });
  }

  private limactlInherited(args: readonly string[], options: { readonly allowFailure?: boolean; readonly ignoredOutput?: boolean } = {}): ReturnType<typeof runInherited> {
    this.ensureLima();
    return runInherited(this.limaBin, args, {
      env: this.limaEnv(),
      ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
      ...(options.ignoredOutput === undefined ? {} : { ignoredOutput: options.ignoredOutput }),
    });
  }

  private async limactlAsyncInherited(args: readonly string[]): Promise<number> {
    this.ensureLima();
    return await runAsyncInherited(this.limaBin, args, { env: this.limaEnv() });
  }

  private vmUsesInstanceSocket(name: string, socketPath: string): boolean {
    const result = this.limactlCapture(["list", name, "--json"], true);
    if (result.status !== 0) {
      return false;
    }
    return limaListJsonContainsSocket(result.stdout, socketPath);
  }

  private startVm(name: string): void {
    const result = this.limactlInherited(["start", "--timeout", this.config.vmStartTimeout, name], {
      allowFailure: true,
    });
    if (result.status === 0) {
      return;
    }
    this.diagnoseStartFailure(name);
    process.exit(1);
  }

  private diagnoseStartFailure(name: string): void {
    const logFile = join(homedir(), ".lima", name, "ha.stderr.log");
    if (!existsSync(logFile)) {
      return;
    }
    const tail = readFileSync(logFile, "utf8").split(/\r?\n/).slice(-80).join("\n");
    if (/Waiting for port to become available on .*:22/.test(tail) && !tail.includes("Started vsock forwarder")) {
      this.log(`${name} VM did not establish Lima SSH over VSOCK.`);
      this.log("Lima is waiting for guest TCP/22 on its default usernet path.");
      this.log("The agent VM should be started with this repo's patched Lima, which skips that usernet NIC and polls VSOCK directly for SSH.");
    }
  }
}

export function limaStatusFromOutput(output: string): VmStatus {
  const status = output.trim();
  switch (status) {
    case "":
      return { state: "missing" };
    case "Running":
      return { state: "running" };
    case "Stopped":
      return { state: "stopped" };
    default:
      return { state: "unexpected", detail: status };
  }
}

export function limaListJsonContainsSocket(output: string, socketPath: string): boolean {
  if (output.trim().length === 0) {
    return false;
  }
  try {
    return jsonContainsSocket(JSON.parse(output), socketPath);
  } catch {
    return output.includes(`"socket":${JSON.stringify(socketPath)}`);
  }
}

function guestCommand(command: readonly string[], options: ExecOptions): readonly string[] {
  if (options.env === undefined || options.env.length === 0) {
    return command;
  }
  return ["env", ...options.env, "--", ...command];
}

function firstToken(output: string): string {
  const token = output.trim().split(/\s+/)[0];
  if (token === undefined || token.length === 0) {
    throw new Error("command produced no output");
  }
  return token;
}

function prefixLines(text: string, prefix: string): string {
  return text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => `${prefix}${line}`).join("\n") + "\n";
}

function jsonContainsSocket(value: unknown, socketPath: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsSocket(item, socketPath));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "socket" && child === socketPath) {
      return true;
    }
    if (jsonContainsSocket(child, socketPath)) {
      return true;
    }
  }
  return false;
}
