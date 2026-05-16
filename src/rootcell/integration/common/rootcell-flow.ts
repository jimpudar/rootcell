import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { loadRootcellInstance, seedRootcellInstanceFiles } from "../../instance.ts";
import { runCapture } from "../../process.ts";
import { buildConfig, RootcellApp } from "../../rootcell.ts";
import type { RootcellConfig } from "../../types.ts";
import type { ProviderBundle, VmNetworkAttachment } from "../../providers/types.ts";
import { applyIntegrationEnvironment, defaultSpyOptions, findRepoDir, TEST_INSTANCE } from "./fixtures.ts";
import type { IntegrationProviderSpec } from "./provider-spec.ts";
import { selectedIntegrationProvider } from "./provider-spec.ts";

export class IntegrationFlow<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly repoDir: string;
  readonly config: RootcellConfig;
  readonly providers: ProviderBundle<TAttachment>;
  readonly app: RootcellApp<TAttachment>;

  constructor(
    readonly provider: IntegrationProviderSpec<TAttachment>,
    importMetaUrl: string,
    private readonly log: (message: string) => void = integrationLog,
  ) {
    this.repoDir = findRepoDir(importMetaUrl);
    applyIntegrationEnvironment(process.env);
    seedRootcellInstanceFiles(this.repoDir, TEST_INSTANCE, this.log);
    loadDotEnv(join(this.repoDir, ".rootcell", "instances", TEST_INSTANCE, ".env"), process.env);
    const instance = loadRootcellInstance(this.repoDir, TEST_INSTANCE, process.env);
    this.config = buildConfig(this.repoDir, process.env, instance);
    this.providers = provider.createBundle(this.config, this.log);
    this.app = new RootcellApp(this.config, this.providers);
  }

  async provision(): Promise<void> {
    await this.provider.preflight();
    const status = await this.app.runAfterEnvironment("provision", [], defaultSpyOptions);
    if (status !== 0) {
      throw new Error(`rootcell provision failed with status ${String(status)}`);
    }
    await this.syncDefaultAllowlists();
  }

  async syncDefaultAllowlists(): Promise<void> {
    this.log("syncing .defaults allowlists into test firewall...");
    mkdirSync(this.config.proxyDir, { recursive: true, mode: 0o700 });
    for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
      copyFileSync(join(this.repoDir, "proxy", `${file}.defaults`), join(this.config.proxyDir, file));
    }
    const status = await this.app.runAfterEnvironment("allow", [], defaultSpyOptions);
    if (status !== 0) {
      throw new Error(`rootcell allow failed with status ${String(status)}`);
    }
  }

  async restartThroughRootcellWrapper(): Promise<void> {
    await this.app.stopVms();
    await this.expectVmStates("stopped");
    const status = await this.app.runAfterEnvironment("", ["true"], defaultSpyOptions);
    if (status !== 0) {
      throw new Error(`rootcell wrapper restart failed with status ${String(status)}`);
    }
    await this.syncDefaultAllowlists();
    await this.agentSh("true");
    await this.expectVmStates("running");
  }

  async expectVmStates(state: "missing" | "running" | "stopped"): Promise<void> {
    const entries = await this.app.listVms();
    for (const entry of entries) {
      if (entry.state !== state) {
        throw new Error(`expected ${entry.vm} to be ${state}, got ${entry.state}`);
      }
    }
  }

  async agentSh(script: string): Promise<string> {
    return await this.guestSh(this.config.agentVm, script);
  }

  async firewallSh(script: string): Promise<string> {
    return await this.guestSh(this.config.firewallVm, script);
  }

  async agentShCapture(script: string): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
    return await this.providers.vm.execCapture(this.config.agentVm, ["bash", "-lc", script], {
      allowFailure: true,
    });
  }

  async agentShFails(script: string): Promise<void> {
    const result = await this.agentShCapture(script);
    if (result.status === 0) {
      throw new Error(result.stdout.length > 0 ? result.stdout : "command unexpectedly succeeded");
    }
  }

  hostCommandOk(command: string, args: readonly string[]): string {
    const result = runCapture(command, args, { allowFailure: true });
    if (result.status !== 0) {
      throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
    }
    return result.stdout;
  }

  hostCommandFails(command: string, args: readonly string[]): void {
    const result = runCapture(command, args, { allowFailure: true });
    if (result.status === 0) {
      throw new Error(result.stdout.length > 0 ? result.stdout : "command unexpectedly succeeded");
    }
  }

  rootcell(args: readonly string[]): string {
    return this.hostCommandOk(join(this.repoDir, "rootcell"), args);
  }

  private async guestSh(vm: string, script: string): Promise<string> {
    const result = await this.providers.vm.execCapture(vm, ["bash", "-lc", script], {
      allowFailure: true,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
    }
    return result.stdout;
  }
}

export function createIntegrationFlow(importMetaUrl: string): IntegrationFlow {
  return new IntegrationFlow(selectedIntegrationProvider(), importMetaUrl);
}

const provisionedFlows = new Map<string, Promise<IntegrationFlow>>();

export async function createProvisionedIntegrationFlow<TAttachment extends VmNetworkAttachment>(
  provider: IntegrationProviderSpec<TAttachment>,
  importMetaUrl: string,
): Promise<IntegrationFlow<TAttachment>> {
  const existing = provisionedFlows.get(provider.id);
  if (existing !== undefined) {
    return await existing as IntegrationFlow<TAttachment>;
  }

  const provisioning = provisionFlow(provider, importMetaUrl);
  provisionedFlows.set(provider.id, provisioning as Promise<IntegrationFlow>);
  try {
    return await provisioning;
  } catch (error) {
    provisionedFlows.delete(provider.id);
    throw error;
  }
}

export async function createProvisionedSelectedIntegrationFlow(importMetaUrl: string): Promise<IntegrationFlow> {
  return await createProvisionedIntegrationFlow(selectedIntegrationProvider(), importMetaUrl);
}

async function provisionFlow<TAttachment extends VmNetworkAttachment>(
  provider: IntegrationProviderSpec<TAttachment>,
  importMetaUrl: string,
): Promise<IntegrationFlow<TAttachment>> {
  const flow = new IntegrationFlow(provider, importMetaUrl);
  await flow.provision();
  return flow;
}

function integrationLog(message: string): void {
  console.error(`test: ${message}`);
}
