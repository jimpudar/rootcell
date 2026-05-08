# Network parameters for the agent + firewall VMs. Imported by agent-vm.nix,
# firewall-vm.nix, and home.nix so a single source of truth drives all the
# IPs, the subnet prefix, and the Lima named-network reference.
#
# Per-user overrides go in network-local.nix (gitignored), which the
# `agent` script generates from .env on each invocation. If that file
# doesn't exist (e.g. you're running `nix flake check` outside the
# script), the defaults below apply.
#
# To change these for a single user account, edit .env (NOT this file)
# and run `./agent provision`. To change the project-wide defaults, edit
# this file. See README → "Running on multiple macOS user accounts" for
# why you'd need to change them.

let
  defaults = {
    # IP of the firewall VM on the inter-VM lima:host network. The agent
    # VM uses this as its default route, DNS server, and SSH proxy.
    firewallIp = "192.168.106.1";

    # IP of the agent VM on the same network.
    agentIp = "192.168.106.2";

    # Subnet prefix length for the inter-VM network.
    networkPrefix = 24;

    # Name of the Lima network entry in ~/.lima/_config/networks.yaml.
    # Both VMs join this network. Default Lima ships with a `host` entry
    # at 192.168.106.0/24 — change if you want a different subnet to
    # avoid colliding with another user account's instance.
    limaNetwork = "host";
  };

  override =
    if builtins.pathExists ./network-local.nix
    then import ./network-local.nix
    else { };
in
defaults // override
