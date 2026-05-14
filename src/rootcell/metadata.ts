export interface SubcommandMetadata {
  readonly name: "provision" | "allow" | "pubkey" | "spy" | "images";
  readonly description: string;
}

export const ROOTCELL_SUBCOMMANDS: readonly SubcommandMetadata[] = [
  { name: "provision", description: "re-copy files and rebuild both VMs" },
  { name: "allow", description: "hot-reload allowlists into the firewall VM" },
  { name: "pubkey", description: "print the agent VM SSH public key" },
  { name: "spy", description: "tail formatted Bedrock traffic from the firewall VM" },
  { name: "images", description: "build or inspect rootcell VM images" },
] as const;

export type RootcellSubcommand = (typeof ROOTCELL_SUBCOMMANDS)[number]["name"];

export function isRootcellSubcommand(value: string | undefined): value is RootcellSubcommand {
  return ROOTCELL_SUBCOMMANDS.some((subcommand) => subcommand.name === value);
}
