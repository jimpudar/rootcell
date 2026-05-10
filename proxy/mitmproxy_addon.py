"""TLS-intercepting allowlist addon for mitmproxy.

Used by two mitmproxy instances on the firewall VM:

  * regular mode (port 8080) — receives explicit HTTP CONNECT from the
    agent VM's SSH ProxyCommand. http_connect inspects the CONNECT host
    against allowed-ssh.txt for port 22.

  * transparent mode (port 8081) — receives nftables-redirected raw TCP
    for port 443. tls_clienthello inspects the SNI from the TLS
    ClientHello against allowed-https.txt; if allowed, mitmproxy
    terminates TLS using our per-deployment CA and opens a NEW TLS
    connection upstream, validating the upstream cert against the SNI.
    The request hook then enforces that the HTTP Host header agrees
    with the SNI of the connection it arrived on.

Why full MITM (was: SNI passthrough): SNI alone doesn't bind the bytes
to the upstream identity. A cooperating client could send
SNI=allowlisted.com but route the TCP to attacker IP, and `curl -k`
(or any client tolerating cert errors) would happily establish a
clean tunnel. With MITM, mitmproxy is the TLS *client* upstream and
validates the upstream cert against the SNI/Host — the attacker IP
can't produce a valid allowlisted.com cert, so the upstream
connection fails and no bytes flow.

Cleartext HTTP is NOT allowlisted. The HTTP `Host` header is
unauthenticated for plaintext connections, AND port 80 is not
NAT-redirected (see firewall-vm.nix), so the request hook never
fires for plain HTTP in normal operation. The deny-all in `request`
for non-TLS flows is defense-in-depth in case any client ever sends
a plain HTTP request to either listener.

The CA private key never leaves the firewall VM (loaded via systemd
LoadCredential into a tmpfs readable only by the mitmproxy service
uid). The agent VM's system trust store includes the CA's public
cert via security.pki.certificateFiles — that's what makes the
minted per-host certs verify.

Allowlists live in /etc/agent-vm/ on the firewall VM. The addon stats
them on every event and reloads on mtime change, so `./agent allow`
takes effect with no service restart.
"""

import fnmatch
import logging
import os
import sys
from mitmproxy import http, tls

# mitmproxy ≥ 11 routes addon logging through stdlib `logging`. In our
# systemd-DynamicUser sandbox, mitmproxy's own termlog handler doesn't
# surface our addon's records to stderr — `journalctl -u mitmproxy-…`
# stays empty. Attach our own StreamHandler so flow decisions land in
# the journal regardless of mitmproxy's internal logging plumbing.
# `propagate=False` avoids duplicate lines if mitmproxy ever does fix
# up the root logger; the handler-existence guard makes addon reload
# (mitmproxy reloads on file mtime change) idempotent.
logger = logging.getLogger("agent_vm_filter")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    logger.propagate = False
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
    logger.addHandler(_h)

ALLOW_HTTPS = "/etc/agent-vm/allowed-https.txt"
ALLOW_SSH = "/etc/agent-vm/allowed-ssh.txt"


class _Cache:
    """Mtime-stamped file reader. Reloads when the file changes on disk."""

    def __init__(self) -> None:
        self.entries: set[str] = set()
        self.mtime: float = -1.0

    def get(self, path: str) -> set[str]:
        try:
            mt = os.path.getmtime(path)
        except FileNotFoundError:
            return set()
        if mt != self.mtime:
            with open(path) as f:
                self.entries = {
                    line.strip()
                    for line in f
                    if line.strip() and not line.lstrip().startswith("#")
                }
            self.mtime = mt
        return self.entries


_https_cache = _Cache()
_ssh_cache = _Cache()


def _matches(host: str, patterns: set[str]) -> bool:
    return any(fnmatch.fnmatchcase(host, p) for p in patterns)


def _deny_tls(data: tls.ClientHelloData, why: str) -> None:
    """Fail-closed deny path for TLS flows.

    Force the passthrough path to fail closed: redirect the upstream to a
    closed local port, then set ignore_connection. mitmproxy will TCP-relay
    to 127.0.0.1:1, get connection-refused, and tear down the client
    tunnel. The denied SNI never sees a byte of the real destination, AND
    the client never sees a mitmproxy-issued cert (which is what makes
    `curl -k` ineffective as a bypass — there's no cert at all).

    Critical dependency: this only works with `connection_strategy=lazy`
    (set in firewall-vm.nix). Under the default `eager`, mitmproxy has
    already opened the upstream to SO_ORIGINAL_DST by the time this hook
    runs, and Server.__setattr__ raises on `address =` mutation of an
    open connection.
    """
    logger.warning(f"DENY https {why}")
    data.context.server.address = ("127.0.0.1", 1)
    data.ignore_connection = True


def http_connect(flow: http.HTTPFlow) -> None:
    host = flow.request.host
    port = flow.request.port

    if port == 443:
        # Decision deferred to tls_clienthello, where the real SNI is visible.
        # (We do NOT trust the CONNECT host string for HTTPS — a client can
        # CONNECT to anything; what matters is the SNI inside the TLS that
        # follows.)
        return

    if port == 22:
        if _matches(host, _ssh_cache.get(ALLOW_SSH)):
            logger.info(f"ALLOW ssh {host}:{port}")
            return
        logger.warning(f"DENY ssh {host}:{port}")
        flow.kill()
        return

    logger.warning(f"DENY connect {host}:{port}")
    flow.kill()


def tls_clienthello(data: tls.ClientHelloData) -> None:
    sni = data.client_hello.sni
    if not sni:
        _deny_tls(data, "sni=<missing>")
        return
    if not _matches(sni, _https_cache.get(ALLOW_HTTPS)):
        _deny_tls(data, f"sni={sni!r}")
        return
    # Allow → fall through. mitmproxy will terminate TLS using our CA
    # (mitmproxy-ca.pem in confdir, see firewall-vm.nix), open a NEW TLS
    # connection upstream, and validate the upstream cert against the SNI.
    # The Host-header check happens in `request` once the HTTP request
    # is decoded.
    logger.info(f"ALLOW https sni={sni}")


def request(flow: http.HTTPFlow) -> None:
    """HTTP-level checks for intercepted TLS flows.

    Two reasons we got here:
      1. A flow that passed tls_clienthello (SNI allowlisted) and is now
         decoded as HTTP. Validate Host header agrees with SNI and is
         itself in the allowlist.
      2. A plain HTTP request that somehow landed on a listener (not
         normally reachable: port 80 is not NAT-redirected). Kill it.
    """
    sni = flow.client_conn.sni
    if not sni:
        # Plain HTTP. No TLS context. Host header is unauthenticated;
        # treat it as theater and kill. See module docstring.
        logger.warning(f"DENY http host={flow.request.pretty_host!r}")
        flow.kill()
        return

    # The HTTP Host header (or HTTP/2 :authority pseudo-header — mitmproxy
    # normalizes both into flow.request.host). pretty_host strips the port.
    host = flow.request.pretty_host
    if not host:
        logger.warning(f"DENY https host=<missing> sni={sni!r}")
        flow.kill()
        return

    # Bind the inner HTTP request to the outer TLS identity. Without this,
    # a client could open TLS with SNI=allowed-cdn.example and then send
    # `Host: attacker-bucket.allowed-cdn.example` to reach a different
    # tenant on the same shared upstream. Strict equality is the correct
    # default; a wildcard SNI cert can serve many Hosts, but those would
    # each need their own allowlist entry anyway.
    if host.lower() != sni.lower():
        logger.warning(f"DENY https host={host!r} != sni={sni!r}")
        flow.kill()
        return

    # Re-check Host against the allowlist. Redundant with tls_clienthello
    # in the common case (host == sni, both allowlisted), but defends
    # against any future relaxation of the SNI/Host equality rule.
    if not _matches(host, _https_cache.get(ALLOW_HTTPS)):
        logger.warning(f"DENY https host={host!r} (not in allowlist)")
        flow.kill()
        return

    logger.info(f"ALLOW https {flow.request.method} {host}{flow.request.path}")
