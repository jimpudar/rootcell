import type { RootcellConfig } from "../types.ts";
import type { ProviderBundle } from "./types.ts";
import { LimaVmProvider } from "./lima.ts";
import { MacOsSocketVmnetNetworkProvider, type LimaSocketNetworkAttachment } from "./macos-socket-vmnet.ts";
import { MacOsVfkitNetworkProvider, type VfkitNetworkAttachment } from "./macos-vfkit-network.ts";
import { VfkitVmProvider } from "./vfkit.ts";

export function createProviderBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<LimaSocketNetworkAttachment | VfkitNetworkAttachment> {
  const provider = process.env.ROOTCELL_VM_PROVIDER ?? "vfkit";
  if (provider === "lima") {
    return {
      network: new MacOsSocketVmnetNetworkProvider(config, log),
      vm: new LimaVmProvider(config, log),
    };
  }
  if (provider !== "vfkit") {
    throw new Error(`unsupported ROOTCELL_VM_PROVIDER '${provider}' (expected vfkit or lima)`);
  }
  return {
    network: new MacOsVfkitNetworkProvider(config, log),
    vm: new VfkitVmProvider(config, log),
  };
}
