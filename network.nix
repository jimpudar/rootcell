# Network parameters for the agent + firewall VMs. Imported by agent-vm.nix,
# firewall-vm.nix, and home.nix so a single source of truth drives all the
# IPs, the subnet prefix, and the Lima named-network reference.
#
# Per-user overrides go in network-local.nix (gitignored), which the
# `rootcell` script generates from .env on each invocation. If that file
# doesn't exist (e.g. you're running `nix flake check` outside the
# script), the defaults below apply.
#
# To change these for a single user account, edit .env (NOT this file)
# and run `./rootcell provision`. To change the project-wide defaults, edit
# this file. See README → "Running on multiple macOS user accounts" for
# why you'd need to change them.

let
  defaults = {
    # IP of the firewall VM on the inter-VM lima:host network. The agent
    # VM uses this as its default route, DNS server, and SSH proxy.
    #
    # NOTE: do not put either VM at the .1 of the subnet. Apple's
    # vmnet.framework (which Lima's `lima:host` network is built on
    # via socket_vmnet) gives the macOS host bridge that .1 address
    # automatically and we can't take it back. If the firewall VM also
    # claims .1, the host bridge and the VM both respond to traffic
    # for that address — ARP races, TCP/UDP get intercepted by the
    # host bridge (which has nothing listening on our ports), and
    # connections from the agent VM see "Connection refused".
    firewallIp = "192.168.106.2";

    # IP of the agent VM on the same network.
    agentIp = "192.168.106.3";

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
