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

  # Networking: only the lima:host interface is configured. The repo's
  # patched Lima launcher skips the default usernet NIC for this VM, so
  # the private socket_vmnet link is enp0s1 and there is no direct host
  # usernet path a root-capable agent could reconfigure into egress.
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;
  # The lima:host link from nixos.yaml. The kernel names it via systemd's
  # predictable scheme. With the default usernet NIC suppressed, this is
  # enp0s1.
  systemd.network.networks."10-enp0s1" = {
    matchConfig.Name = "enp0s1";
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

  # No HTTP-proxy env config here. The firewall VM intercepts TCP/443 at
  # the network layer via nftables NAT REDIRECT, so plain
  # `curl https://github.com` (and nix-daemon's fetches) Just Work without
  # any in-VM proxy awareness. Cleartext TCP/80 is not redirected — it's
  # dropped on the firewall, because HTTP `Host` is unauthenticated and
  # can't be allowlisted safely. All egress must be HTTPS or SSH. SSH
  # still uses an explicit ProxyCommand — see programs.ssh in home.nix.
  #
  # The firewall VM's mitmproxy now terminates TLS for allowlisted hosts
  # (it was passthrough before) and presents per-host certs minted by a
  # per-deployment CA. Trust that CA system-wide so curl/git/openssl
  # accept the minted certs without `--insecure`. The cert is shipped
  # in by ./rootcell (see AGENT_NIX_FILES); the matching key never leaves
  # the host or the firewall VM.
  #
  # Why MITM instead of passthrough: passthrough binds the bytes only to
  # the SNI in the ClientHello, not to the upstream identity. A client
  # cooperating with an exfil endpoint could send SNI=allowed.com but
  # route the TCP to attacker IP, and `curl -k` (or any client that
  # tolerates cert errors) would establish a clean tunnel. With MITM,
  # mitmproxy is the TLS *client* upstream and the attacker IP can't
  # produce a valid allowed.com cert — so no bytes flow.
  security.pki.certificateFiles = [ ./pki/agent-vm-ca-cert.pem ];

  # Common SDK trust-store env vars. NixOS's security.pki.certificateFiles
  # adds the CA to /etc/ssl/certs/ca-certificates.crt, which curl, git,
  # and OpenSSL pick up automatically. Node, Python `requests`, and a few
  # other ecosystems read their CA bundle from a hardcoded path or env
  # var instead, so set those explicitly. Pi, Claude Code, Codex, etc.
  # are all Node CLIs — without NODE_EXTRA_CA_CERTS they'd fail TLS to
  # every allowlisted host the moment MITM is enabled.
  environment.variables = {
    NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";
    SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
    REQUESTS_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
  };
}
