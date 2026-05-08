{ config, pkgs, lib, username, ... }:

let
  net = import ./network.nix;
in

# Firewall VM: a tiny appliance VM that brokers all egress for the agent VM.
#
# Two NICs (kernel names from systemd predictable naming):
#   enp0s1  vzNAT       — internet egress (default route)
#   enp0s2  lima:host   — private link to the agent VM (default
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

  # enp0s2 = lima:host, our private link to the agent VM. (The kernel
  # names this NIC enp0s2 via systemd predictable naming because it's
  # the second virtio-net device — Lima's `interface:` field can't
  # actually rename the kernel device, so we just use enp0s2 directly.)
  # Static address; DHCP would conflict with the agent's static .2.
  systemd.network.networks."20-enp0s2" = {
    matchConfig.Name = "enp0s2";
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
  # below for the REDIRECT rules. Inbound on enp0s2 (the lima:host link
  # to the agent VM) is allowed only on the explicit-mitmproxy port
  # (8080), the transparent-mitmproxy port (8081, which is the
  # post-REDIRECT destination), and dnsmasq (53).
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    interfaces.enp0s2 = {
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
        # iifname (not iif) so NixOS's build-time `nft -c` validation
        # doesn't fail — iif resolves to a kernel ifindex at parse time
        # and the device doesn't exist on the build host. iifname is a
        # string match resolved at rule-load time inside the running
        # guest. The interface is enp0s2 (the second virtio-net,
        # enp0s1 is the Apple Virtio NAT we don't configure).
        iifname "enp0s2" tcp dport 80  redirect to :8081
        iifname "enp0s2" tcp dport 443 redirect to :8081
      }
    '';
  };

  # ── Mutable allowlist directory ───────────────────────────────────────
  # `./agent allow` writes here via `limactl cp`, which connects as the
  # unprivileged Lima guest user — so the dir is owned by ${username},
  # not root. The dnsmasq-allowlist.conf seed is empty: dnsmasq's
  # pre-start check refuses to launch without the conf-file existing,
  # but with `no-resolv` and no `server=` directives, an empty
  # conf-file means every query returns REFUSED — fail-closed by
  # default until reload.sh runs and writes the real allowlist. The
  # `f` rule only creates if missing, so the file we write later via
  # reload.sh isn't clobbered; reload.sh runs as root (via sudo) and
  # can overwrite root-owned files in a user-owned directory.
  systemd.tmpfiles.rules = [
    "d /etc/agent-vm 0755 ${username} users -"
    "f /etc/agent-vm/dnsmasq-allowlist.conf 0644 root root -"
  ];

  # ── mitmproxy ─────────────────────────────────────────────────────────
  # The addon is in /etc via environment.etc so it has a stable path that
  # systemd's strict sandboxing can read. It stats the allowlist files on
  # every event and reloads on mtime change, so `./agent allow` takes
  # effect with no service restart.
  #
  # Both services bind 0.0.0.0 (not net.firewallIp) — even with
  # `After=network-online.target`, mitmproxy can race ahead of
  # systemd-networkd assigning enp0s2's static address and bind() fails
  # with "could not bind on any address". 0.0.0.0 sidesteps the race
  # without weakening the security boundary: networking.firewall (above)
  # only allows TCP/8080 and TCP/8081 inbound on enp0s2, so the agent VM
  # is still the only thing that can reach these ports.
  environment.etc."agent-vm/mitmproxy_addon.py".source = ./proxy/mitmproxy_addon.py;

  # mitmproxy unconditionally materializes a `confdir` on startup (even
  # in passthrough mode where we don't use the cert store). Default is
  # ~/.mitmproxy, but DynamicUser+ProtectSystem leaves $HOME pointing at
  # `/` which is read-only, so the mkdir fails. StateDirectory gives
  # each service a private writable dir at /var/lib/<name>, and we point
  # mitmproxy's confdir there.
  systemd.services.mitmproxy-explicit = {
    description = "mitmproxy (explicit CONNECT — for SSH ProxyCommand)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    # Restart when the addon source changes. mitmproxy reloads scripts on
    # mtime, but it only re-reads function bodies — module-level state
    # (logger handler attachment, caches) is set once at process start.
    # Force a clean restart so addon edits actually take effect on
    # `./agent provision`.
    restartTriggers = [ ./proxy/mitmproxy_addon.py ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode regular"
        "--listen-host 0.0.0.0"
        "--listen-port 8080"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "--set confdir=/var/lib/mitmproxy-explicit"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      StateDirectory = "mitmproxy-explicit";
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
    restartTriggers = [ ./proxy/mitmproxy_addon.py ];
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode transparent"
        "--listen-host 0.0.0.0"
        "--listen-port 8081"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "--set confdir=/var/lib/mitmproxy-transparent"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      StateDirectory = "mitmproxy-transparent";
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadOnlyPaths = "/etc/agent-vm";
      Restart = "on-failure";
      RestartSec = "2s";
      # Transparent mode binds the listening socket with IP_TRANSPARENT
      # (needed even though our packets arrive via NAT REDIRECT to a local
      # IP — mitmproxy sets the sockopt unconditionally in transparent
      # mode). IP_TRANSPARENT requires CAP_NET_ADMIN, which DynamicUser
      # services don't have by default. Grant it as an ambient capability
      # so the binary inherits it without needing setcap on disk. We do
      # NOT set NoNewPrivileges=true here because that interacts badly
      # with AmbientCapabilities under DynamicUser; the rest of the
      # sandbox (DynamicUser + ProtectSystem + ReadOnlyPaths) stays.
      AmbientCapabilities = [ "CAP_NET_ADMIN" ];
      CapabilityBoundingSet = [ "CAP_NET_ADMIN" ];
    };
  };

  # ── dnsmasq ───────────────────────────────────────────────────────────
  # The conf-file is generated by /etc/agent-vm/reload.sh from
  # allowed-dns.txt and reloaded with SIGHUP. systemd.tmpfiles seeds it
  # with a catch-all (above) so the pre-start check passes on first boot.
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      listen-address = net.firewallIp;
      # bind-dynamic, not bind-interfaces: the latter requires the listen
      # address to already be configured on an interface at start time,
      # which races with systemd-networkd assigning enp0s2's static IP.
      # bind-dynamic uses IP_FREEBIND and tracks interface changes.
      bind-dynamic = true;
      no-resolv = true;
      domain-needed = true;
      bogus-priv = true;
      conf-file = "/etc/agent-vm/dnsmasq-allowlist.conf";
    };
  };

  # Belt-and-suspenders: even with bind-dynamic, wait for the network to
  # be online so the first listen-address bind reliably finds enp0s2.
  systemd.services.dnsmasq = {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
  };

  # ── Reload helper ─────────────────────────────────────────────────────
  # `./agent allow` runs this after copying new allowlist files in.
  environment.etc."agent-vm/reload.sh" = {
    source = ./proxy/reload.sh;
    mode = "0755";
  };
}
