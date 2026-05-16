import type { RootcellConfig } from "../../types.ts";
import type { ProviderBundle, VmNetworkAttachment } from "../../providers/types.ts";
import { macOsVfkitIntegrationProvider } from "../providers/macos-vfkit/provider.ts";

export interface IntegrationProviderSpec<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly guestArchitecture: string;
  createBundle(config: RootcellConfig, log: (message: string) => void): ProviderBundle<TAttachment>;
  preflight(): Promise<void>;
  stopTestResources(repoDir: string): Promise<void>;
  removeTestState(repoDir: string): Promise<void>;
}

const providers = [
  macOsVfkitIntegrationProvider,
] as const satisfies readonly IntegrationProviderSpec[];

export function selectedIntegrationProvider(): IntegrationProviderSpec {
  const id = process.env.ROOTCELL_INTEGRATION_PROVIDER ?? "macos-vfkit";
  const provider = providers.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    throw new Error(`unknown integration provider '${id}'`);
  }
  return provider;
}
