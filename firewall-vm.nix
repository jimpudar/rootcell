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
# Hybrid filtering — HTTPS is intercepted, SSH is explicit, HTTP is denied:
#
#   HTTPS traffic from the agent VM is intercepted by nftables NAT
#   PREROUTING REDIRECT (TCP 443 → local :8081), so the agent VM's
#   `curl https://github.com` works without any proxy env vars. mitmproxy
#   in transparent mode reads the original destination via SO_ORIGINAL_DST
#   and the SNI from the TLS ClientHello. If the SNI is in the allowlist
#   mitmproxy terminates TLS (using our per-deployment CA, trusted by the
#   agent VM via security.pki.certificateFiles) and opens a NEW TLS
#   connection upstream, validating the upstream cert against the SNI/Host.
#   That validation is the whole point of the MITM: with passthrough, a
#   client cooperating with the exfil endpoint could send SNI=github.com
#   while routing the TCP to attacker IP, and `curl -k` would accept the
#   attacker's cert. With MITM, mitmproxy is the TLS *client* upstream and
#   the attacker IP can't produce a valid github.com cert.
#
#   SSH is explicit. The agent VM's `programs.ssh.matchBlocks` (in home.nix)
#   sets a ProxyCommand that opens an HTTP CONNECT tunnel to mitmproxy
#   running in regular mode on :8080. mitmproxy's addon allowlists by
#   CONNECT host:22. SSH is not MITM'd — that would break key-based auth
#   from inside the VM.
#
#   Cleartext HTTP (TCP/80) is NOT proxied and NOT forwarded. The HTTP
#   `Host` header is unauthenticated — a client can claim any allowlisted
#   name while connecting to any IP, so a Host-header allowlist gives no
#   real guarantee. Without a NAT REDIRECT for port 80, packets hit
#   FORWARD with no rule and are dropped (ip_forward=0 backstops this).
#   All egress must be HTTPS or SSH.
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
# Allowlists are mutable runtime files (NOT Nix-store) so `./rootcell allow`
# can hot-reload them without a guest rebuild.

{
  imports = [ ./common.nix ];

  networking.hostName = "firewall-vm";
  environment.systemPackages = [ pkgs.python3 ];

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

  # NAT REDIRECT for transparent HTTPS. Lives in its own table so it
  # doesn't tangle with the NixOS-generated firewall table. The dstnat hook
  # rewrites the destination IP/port BEFORE the routing decision, so the
  # packet lands in INPUT chain (not FORWARD) and is delivered to mitmproxy.
  #
  # Only TCP/443 is redirected. TCP/80 is intentionally NOT redirected:
  # cleartext HTTP can't be allowlisted safely (Host header is unauthenticated),
  # so port-80 packets fall through to FORWARD with no rule and are dropped.
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
        iifname "enp0s2" tcp dport 443 redirect to :8081
      }
    '';
  };

  # ── Mutable allowlist directory ───────────────────────────────────────
  # `./rootcell allow` writes here via `limactl cp`, which connects as the
  # unprivileged Lima guest user — so the dir is owned by ${username},
  # not root. The dnsmasq-allowlist.conf seed is empty: dnsmasq's
  # pre-start check refuses to launch without the conf-file existing,
  # but with `no-resolv` and no `server=` directives, an empty
  # conf-file means every query returns REFUSED — fail-closed by
  # default until reload.sh runs and writes the real allowlist. The
  # `f` rule only creates if missing, so the file we write later via
  # reload.sh isn't clobbered; reload.sh runs as root (via sudo) and
  # can overwrite root-owned files in a user-owned directory.
  #
  # The CA pem (key + cert) for TLS MITM is staged here too, but
  # written by `./rootcell` via `limactl cp /tmp + sudo install -m 0600
  # -o root -g root` — never touchable by the lima user (who has
  # passwordless sudo, but the explicit ownership chmod makes the
  # blast radius "must already be root" rather than "any read of
  # /etc/agent-vm leaks the key"). Loaded into the mitmproxy services
  # via systemd LoadCredential, which surfaces it as a tmpfs file
  # readable only by the service uid.
  systemd.tmpfiles.rules = [
    "d /etc/agent-vm 0755 ${username} users -"
    "f /etc/agent-vm/dnsmasq-allowlist.conf 0644 root root -"
    "d /run/agent-vm-spy 1777 root root -"
  ];

  # ── mitmproxy ─────────────────────────────────────────────────────────
  # The addon is in /etc via environment.etc so it has a stable path that
  # systemd's strict sandboxing can read. It stats the allowlist files on
  # every event and reloads on mtime change, so `./rootcell allow` takes
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
  environment.etc."agent-vm/agent_spy.py" = {
    source = ./proxy/agent_spy.py;
    mode = "0755";
  };

  # mitmproxy unconditionally materializes a `confdir` on startup. It
  # also LOOKS in confdir for `mitmproxy-ca.pem`; if present it uses
  # that as the signing CA, otherwise it auto-generates one. We want
  # mitmproxy to use OUR CA (the one whose public cert the agent VM
  # trusts), so we:
  #
  #   1. Stage the key+cert pem at /etc/agent-vm/agent-vm-ca.pem
  #      (root-owned, mode 0600, written by `./rootcell`).
  #   2. systemd LoadCredential reads it as root and surfaces it under
  #      $CREDENTIALS_DIRECTORY (a per-service tmpfs that only the
  #      service uid can read).
  #   3. ExecStartPre copies the credential into the per-service
  #      RuntimeDirectory (which IS writable, unlike the credentials
  #      tmpfs mitmproxy can't write its own runtime artifacts into).
  #   4. mitmproxy is launched with --set confdir pointing at the
  #      RuntimeDirectory and finds mitmproxy-ca.pem already there.
  #
  # ConditionPathExists guards the bootstrap window: on the very first
  # nixos-rebuild the CA is not yet copied in (./rootcell does that AFTER
  # rebuild — we can't `limactl cp` to /etc/agent-vm/ before tmpfiles
  # creates the dir), so the services skip cleanly. ./rootcell then pushes
  # the CA and `systemctl restart`s, which re-evaluates the condition.
  systemd.services.mitmproxy-explicit = {
    description = "mitmproxy (explicit CONNECT — for SSH ProxyCommand)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/etc/agent-vm/agent-vm-ca.pem";
    # Restart when the addon source changes. mitmproxy reloads scripts on
    # mtime, but it only re-reads function bodies — module-level state
    # (logger handler attachment, caches) is set once at process start.
    # Force a clean restart so addon edits actually take effect on
    # `./rootcell provision`.
    restartTriggers = [ ./proxy/mitmproxy_addon.py ./proxy/agent_spy.py ];
    serviceConfig = {
      LoadCredential = "mitmproxy-ca.pem:/etc/agent-vm/agent-vm-ca.pem";
      RuntimeDirectory = "mitmproxy-explicit";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0400 %d/mitmproxy-ca.pem %t/mitmproxy-explicit/mitmproxy-ca.pem";
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode regular"
        "--listen-host 0.0.0.0"
        "--listen-port 8080"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        # Defer opening the upstream TCP connection until after our addon
        # runs. Originally needed for the SNI deny path's address rewrite
        # to take effect (the default "eager" strategy opens the upstream
        # before tls_clienthello fires, and Server.address can't be mutated
        # on an already-open connection). Still required: with MITM, the
        # addon may decide to deny based on SNI before any upstream open.
        "--set connection_strategy=lazy"
        "--set confdir=%t/mitmproxy-explicit"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      ReadOnlyPaths = "/etc/agent-vm";
      ReadWritePaths = "/run/agent-vm-spy";
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };

  systemd.services.mitmproxy-transparent = {
    description = "mitmproxy (transparent — for NAT-redirected HTTPS)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/etc/agent-vm/agent-vm-ca.pem";
    restartTriggers = [ ./proxy/mitmproxy_addon.py ./proxy/agent_spy.py ];
    serviceConfig = {
      LoadCredential = "mitmproxy-ca.pem:/etc/agent-vm/agent-vm-ca.pem";
      RuntimeDirectory = "mitmproxy-transparent";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0400 %d/mitmproxy-ca.pem %t/mitmproxy-transparent/mitmproxy-ca.pem";
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode transparent"
        "--listen-host 0.0.0.0"
        "--listen-port 8081"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "--set connection_strategy=lazy"
        "--set confdir=%t/mitmproxy-transparent"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadOnlyPaths = "/etc/agent-vm";
      ReadWritePaths = "/run/agent-vm-spy";
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
  # `./rootcell allow` runs this after copying new allowlist files in.
  environment.etc."agent-vm/reload.sh" = {
    source = ./proxy/reload.sh;
    mode = "0755";
  };
}
