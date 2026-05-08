{ config, pkgs, lib, ... }:

# Agent VM: where the coding agent runs. The agent has root inside this VM,
# so this VM is treated as untrusted from the host's perspective. Its only
# network interface points at the firewall VM (net.firewallIp), which
# enforces the egress allowlists (mitmproxy + dnsmasq).

let
  net = import ./network.nix;
in
{
  imports = [ ./common.nix ];

  networking.hostName = "agent-vm";

  # No firewall inside this VM — the agent has root and could rewrite it
  # anyway. All meaningful filtering happens in the firewall VM.
  networking.firewall.enable = false;

  # Networking: ONLY the lima:host interface (lima0). No Virtio NAT, no
  # IPv6, no path to the internet that bypasses the firewall VM.
  # `limactl shell` keeps working because ssh.overVsock=true is the default
  # on vz+Linux, so the SSH control plane is independent of any IP NIC.
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;
  systemd.network.networks."10-lima0" = {
    matchConfig.Name = "lima0";
    networkConfig = {
      DHCP = "no";
      IPv6AcceptRA = false;
      LinkLocalAddressing = "no";
    };
    address = [ "${net.agentIp}/${toString net.networkPrefix}" ];
    routes = [ { Gateway = net.firewallIp; } ];
    dns = [ net.firewallIp ];
  };

  # Belt-and-suspenders: even if a default route appeared on something else,
  # disable v6 system-wide so we have no v6 leak path.
  boot.kernel.sysctl = {
    "net.ipv6.conf.all.disable_ipv6" = 1;
    "net.ipv6.conf.default.disable_ipv6" = 1;
  };

  # Don't let any future module sneak entries in /etc/hosts that resolve
  # without going through dnsmasq. (Empty by default in NixOS but make it
  # explicit so it's an invariant, not an accident.)
  networking.hosts = lib.mkForce {};

  # No HTTP-proxy env config here. The firewall VM intercepts TCP/80 and
  # TCP/443 at the network layer via nftables NAT REDIRECT, so plain
  # `curl https://github.com` (and nix-daemon's fetches) Just Work without
  # any in-VM proxy awareness. SSH still uses an explicit ProxyCommand —
  # see programs.ssh in home.nix.
}
