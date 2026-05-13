export interface SubcommandMetadata {
  readonly name: "provision" | "allow" | "pubkey" | "spy";
  readonly description: string;
}

export const ROOTCELL_SUBCOMMANDS: readonly SubcommandMetadata[] = [
  { name: "provision", description: "re-copy files and re-rebuild both VMs" },
  { name: "allow", description: "hot-reload allowlists into the firewall VM" },
  { name: "pubkey", description: "print the agent VM SSH public key" },
  { name: "spy", description: "tail formatted Bedrock traffic from the firewall VM" },
] as const;

export type RootcellSubcommand = (typeof ROOTCELL_SUBCOMMANDS)[number]["name"];

export function isRootcellSubcommand(value: string | undefined): value is RootcellSubcommand {
  return ROOTCELL_SUBCOMMANDS.some((subcommand) => subcommand.name === value);
}
