"""SNI / CONNECT-host allowlist addon for mitmproxy.

Used by two mitmproxy instances on the firewall VM:

  * regular mode (port 8080) — receives explicit HTTP CONNECT from the
    agent VM's SSH ProxyCommand. http_connect inspects the CONNECT host
    against allowed-ssh.txt for port 22.

  * transparent mode (port 8081) — receives nftables-redirected raw TCP
    for port 443. tls_clienthello inspects the SNI from the TLS
    ClientHello against allowed-https.txt.

Cleartext HTTP is NOT allowlisted. The HTTP `Host` header is
unauthenticated — the client invents the string with no cryptographic
binding to the upstream IP — so a Host-header allowlist gives no real
guarantee. Port 80 is not NAT-redirected (see firewall-vm.nix) so this
hook normally never fires; the deny-all in `request` is defense-in-depth
in case any client ever sends a plain HTTP request to either listener.

In all allow paths the addon NEVER decrypts (no MITM, no CA in the
guest). It either kills the flow or sets ignore_connection, which makes
mitmproxy relay raw bytes between client and upstream.

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


def http_connect(flow: http.HTTPFlow) -> None:
    host = flow.request.host
    port = flow.request.port

    if port == 443:
        # Decision deferred to tls_clienthello, where the real SNI is visible.
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
    if not sni or not _matches(sni, _https_cache.get(ALLOW_HTTPS)):
        logger.warning(f"DENY https sni={sni!r}")
        # Force the passthrough path to fail closed: redirect the
        # upstream to a closed local port, then set ignore_connection.
        # mitmproxy will TCP-relay to 127.0.0.1:1, get connection-
        # refused, and tear down the client tunnel. The denied SNI
        # never sees a byte of the real destination.
        #
        # Critical dependency: this only works with
        # `connection_strategy=lazy` (set in firewall-vm.nix). Under
        # the default `eager`, mitmproxy has already opened the upstream
        # to SO_ORIGINAL_DST by the time this hook runs, and
        # Server.__setattr__ raises on `address =` mutation of an open
        # connection. The hook dispatcher swallows that exception, so
        # ignore_connection is never set, and mitmproxy falls through
        # to a full MITM (CN=mitmproxy cert + relay to real upstream)
        # — making the deny path a no-op for any client that ignores
        # cert errors (e.g. `curl -k`).
        data.context.server.address = ("127.0.0.1", 1)
        data.ignore_connection = True
        return

    logger.info(f"ALLOW https sni={sni}")
    # Passthrough: relay raw bytes, no TLS termination. No CA needed in the
    # guest. The proxy never sees plaintext.
    data.ignore_connection = True


def request(flow: http.HTTPFlow) -> None:
    """Deny all cleartext HTTP. Host header is unauthenticated, so any
    allowlist on it is theater — see module docstring."""
    # In normal operation this hook is unreachable: port 80 is not
    # NAT-redirected (firewall-vm.nix) and the explicit-mode listener
    # only ever sees CONNECT for SSH. Kept as defense-in-depth so a
    # misconfigured client (e.g. an accidental HTTP_PROXY pointing at
    # :8080) still fails closed instead of being silently proxied.
    # tls_clienthello short-circuits HTTPS via ignore_connection, so
    # allowed HTTPS flows never reach this hook.
    host = flow.request.pretty_host
    logger.warning(f"DENY http host={host}")
    flow.kill()
