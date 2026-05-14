# Network parameters for the agent + firewall VMs. Imported by agent-vm.nix,
# firewall-vm.nix, and home.nix so a single source of truth drives all the
# IPs and the subnet prefix.
#
# Per-instance overrides are copied into the guest as network-local.nix, which
# `rootcell` generates from .rootcell/instances/<name>/state.json. If that file
# doesn't exist (e.g. you're running `nix flake check` outside the script), the
# defaults below apply.
#
# To change these for one instance, edit that instance's state/config and run
# `./rootcell --instance <name> provision`. To change project-wide fallback
# defaults, edit this file.

let
  defaults = {
    # IP of the firewall VM on the inter-VM socket_vmnet network. The
    # agent VM uses this as its default route, DNS server, and SSH proxy.
    #
    # NOTE: do not put either VM at the .1 of the subnet. Apple's
    # Keep .1 free. vmnet.framework may reserve that address for the host
    # side of host-mode networks, and using it in the firewall VM creates
    # confusing ARP and connection behavior.
    firewallIp = "192.168.100.2";

    # IP of the agent VM on the same network.
    agentIp = "192.168.100.3";

    # Subnet prefix length for the inter-VM network.
    networkPrefix = 24;

  };

  override =
    if builtins.pathExists ./network-local.nix
    then import ./network-local.nix
    else { };
in
defaults // override
