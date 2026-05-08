{ config, pkgs, lib, ... }:

let
  net = import ./network.nix;
in

# Firewall VM: a tiny appliance VM that brokers all egress for the agent VM.
#
# Two NICs:
#   enp0s1  vzNAT       — internet egress (default route)
#   lima0   lima:host   — private link to the agent VM (default
#                          192.168.106.0/24, overridable via .env;
#                          IPs come from network.nix)
#
# Hybrid filtering — HTTPS is transparent, SSH is explicit:
#
#   HTTPS/HTTP traffic from the agent VM is intercepted by nftables NAT
#   PREROUTING REDIRECT (TCP 80, 443 → local :8081), so the agent VM's
#   `curl https://github.com` works without any proxy env vars. mitmproxy
#   in transparent mode reads the original destination via SO_ORIGINAL_DST
#   and the SNI from the TLS ClientHello, then either kills the connection
#   (deny) or relays raw bytes (allow — no MITM).
#
#   SSH is explicit. The agent VM's `programs.ssh.matchBlocks` (in home.nix)
#   sets a ProxyCommand that opens an HTTP CONNECT tunnel to mitmproxy
#   running in regular mode on :8080. mitmproxy's addon allowlists by
#   CONNECT host:22.
#
#   DNS is explicit too — the agent VM's networkConfig.DNS points at the
#   firewall directly. dnsmasq forwards allowlisted suffixes to 1.1.1.1;
#   everything else returns 0.0.0.0.
#
# Why two mitmproxy instances? mitmproxy listens in one mode at a time —
# transparent expects raw redirected TCP, regular expects HTTP CONNECT.
# Both use the same addon (Python file), but separate sockets and modes.
#
# Why no IP forwarding? With ip_forward=0 the kernel refuses to forward
# packets at all. The NAT REDIRECT path doesn't need forwarding because
# DNAT rewrites the destination to local before the routing decision —
# packets land in INPUT, not FORWARD. Any TCP traffic that doesn't match
# the REDIRECT rule (e.g., agent's direct attempt to github.com:22) gets
# dropped because there's no route. Belt-and-suspenders against any
# escape via unredirected ports.
#
# Allowlists are mutable runtime files (NOT Nix-store) so `./agent allow`
# can hot-reload them without a guest rebuild.

{
  imports = [ ./common.nix ];

  networking.hostName = "firewall-vm";

  # ── Networking ────────────────────────────────────────────────────────
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;

  # enp0s1 = vzNAT, our internet-egress NIC. Default route lives here.
  systemd.network.networks."10-enp0s1" = {
    matchConfig.Name = "enp0s1";
    networkConfig.DHCP = "ipv4";
  };

  # lima0 = lima:host, our private link to the agent VM. Static address;
  # DHCP would conflict with the agent's static .2.
  systemd.network.networks."20-lima0" = {
    matchConfig.Name = "lima0";
    networkConfig = {
      DHCP = "no";
      IPv6AcceptRA = false;
      LinkLocalAddressing = "no";
    };
    address = [ "${net.firewallIp}/${toString net.networkPrefix}" ];
  };

  boot.kernel.sysctl = {
    # See the header comment for why forwarding stays off.
    "net.ipv4.ip_forward" = 0;
    "net.ipv6.conf.all.forwarding" = 0;
    "net.ipv6.conf.all.disable_ipv6" = 1;
    "net.ipv6.conf.default.disable_ipv6" = 1;
  };

  # ── Firewall ──────────────────────────────────────────────────────────
  # NixOS firewall manages the filter table. We add a separate nat table
  # below for the REDIRECT rules. Inbound on lima0 is allowed only on the
  # explicit-mitmproxy port (8080), the transparent-mitmproxy port (8081,
  # which is the post-REDIRECT destination), and dnsmasq (53).
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    interfaces.lima0 = {
      allowedTCPPorts = [ 8080 8081 ];
      allowedUDPPorts = [ 53 ];
    };
  };

  # NAT REDIRECT for transparent HTTPS/HTTP. Lives in its own table so it
  # doesn't tangle with the NixOS-generated firewall table. The dstnat hook
  # rewrites the destination IP/port BEFORE the routing decision, so the
  # packet lands in INPUT chain (not FORWARD) and is delivered to mitmproxy.
  networking.nftables.tables.agent-vm-nat = {
    family = "ip";
    content = ''
      chain prerouting {
        type nat hook prerouting priority dstnat;
        iif "lima0" tcp dport 80  redirect to :8081
        iif "lima0" tcp dport 443 redirect to :8081
      }
    '';
  };

  # ── Mutable allowlist directory ───────────────────────────────────────
  # `./agent allow` writes here via `limactl cp`. Not in the Nix store.
  systemd.tmpfiles.rules = [
    "d /etc/agent-vm 0755 root root -"
  ];

  # ── mitmproxy ─────────────────────────────────────────────────────────
  # The addon is in /etc via environment.etc so it has a stable path that
  # systemd's strict sandboxing can read. It stats the allowlist files on
  # every event and reloads on mtime change, so `./agent allow` takes
  # effect with no service restart.
  environment.etc."agent-vm/mitmproxy_addon.py".source = ./proxy/mitmproxy_addon.py;

  systemd.services.mitmproxy-explicit = {
    description = "mitmproxy (explicit CONNECT — for SSH ProxyCommand)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode regular"
        "--listen-host ${net.firewallIp}"
        "--listen-port 8080"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      ReadOnlyPaths = "/etc/agent-vm";
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };

  systemd.services.mitmproxy-transparent = {
    description = "mitmproxy (transparent — for NAT-redirected HTTPS/HTTP)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode transparent"
        "--listen-host ${net.firewallIp}"
        "--listen-port 8081"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      ReadOnlyPaths = "/etc/agent-vm";
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };

  # ── dnsmasq ───────────────────────────────────────────────────────────
  # The conf-file is generated by /etc/agent-vm/reload.sh from
  # allowed-dns.txt and reloaded with SIGHUP. On first boot the file may
  # not exist yet — services.dnsmasq tolerates that.
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      listen-address = net.firewallIp;
      bind-interfaces = true;
      no-resolv = true;
      domain-needed = true;
      bogus-priv = true;
      conf-file = "/etc/agent-vm/dnsmasq-allowlist.conf";
    };
  };

  # ── Reload helper ─────────────────────────────────────────────────────
  # `./agent allow` runs this after copying new allowlist files in.
  environment.etc."agent-vm/reload.sh" = {
    source = ./proxy/reload.sh;
    mode = "0755";
  };
}
