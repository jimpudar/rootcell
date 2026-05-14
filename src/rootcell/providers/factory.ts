import type { RootcellConfig } from "../types.ts";
import type { ProviderBundle } from "./types.ts";
import { LimaVmProvider } from "./lima.ts";
import { MacOsSocketVmnetNetworkProvider, type LimaSocketNetworkAttachment } from "./macos-socket-vmnet.ts";

export function createProviderBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<LimaSocketNetworkAttachment> {
  return {
    network: new MacOsSocketVmnetNetworkProvider(config, log),
    vm: new LimaVmProvider(config, log),
  };
}
