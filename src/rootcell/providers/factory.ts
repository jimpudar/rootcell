import type { RootcellConfig } from "../types.ts";
import type { ProviderBundle } from "./types.ts";
import { MacOsVfkitNetworkProvider, type VfkitNetworkAttachment } from "./macos-vfkit-network.ts";
import { VfkitVmProvider } from "./vfkit.ts";

export function createProviderBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<VfkitNetworkAttachment> {
  return {
    network: new MacOsVfkitNetworkProvider(config, log),
    vm: new VfkitVmProvider(config, log),
  };
}
