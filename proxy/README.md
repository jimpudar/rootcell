# proxy/

The egress firewall for the agent VM. All outbound traffic from the agent
VM passes through services running in the firewall VM:

- **mitmproxy (transparent)** at `192.168.106.2:8081` — receives TCP/443
  packets that nftables NAT REDIRECT intercepts on the inter-VM link.
  Reads the TLS SNI from the ClientHello and matches against
  `allowed-https.txt`. On allow, **terminates TLS** using a
  per-deployment CA (the matching cert is in the agent VM's trust
  store) and opens a fresh TLS connection upstream — validating the
  upstream cert against the SNI/Host. The HTTP `Host` header is then
  required to equal the SNI and itself be in the allowlist, so a client
  can't tunnel out through a shared-IP CDN by lying about Host. On
  deny, the upstream is redirected to `127.0.0.1:1` so the client TCP
  handshake gets RST and no mitmproxy-issued cert is ever presented
  (which would otherwise be the foothold for a `curl -k` bypass).
- **mitmproxy (explicit / CONNECT)** at `192.168.106.2:8080` — handles
  the agent VM's SSH `ProxyCommand`, which speaks HTTP `CONNECT host:22`.
  Matches against `allowed-ssh.txt`.
- **dnsmasq** at `192.168.106.2:53` — DNS resolver that forwards names
  matching `allowed-dns.txt` to 1.1.1.1 and returns `REFUSED` for
  everything else.

Cleartext HTTP (TCP/80) is **not** proxied. The HTTP `Host` header is
unauthenticated — a client can claim any allowlisted name while connecting
to any IP — so a Host-header allowlist is theater. Port 80 is not
NAT-redirected; packets hit FORWARD with no rule and are dropped. Both
mitmproxy instances also kill any plain HTTP request that reaches them,
as defense-in-depth. All egress must be HTTPS or SSH.

The two mitmproxy instances share the same Python addon (mitmproxy can
only run one mode per process). HTTPS is transparent by design; SSH
stays explicit (hostname allowlist) and is **not** MITM'd — TLS
intercepting SSH would break key-based auth from inside the VM.

The three allowlist files are gitignored; `./agent` seeds each from its
`.defaults` sibling on first run. Edit the live `*.txt` to customize;
delete the live file and re-run `./agent` to reset to project defaults.

## CA materials

`./agent` generates a per-deployment CA the first time it runs and
persists it under `pki/` on the host (gitignored). Three files:

- `pki/agent-vm-ca.key` — RSA 2048 private key, mode 0600. Host only.
- `pki/agent-vm-ca-cert.pem` — public cert. Shipped into the agent VM
  via `security.pki.certificateFiles` so the system trust store
  accepts mitmproxy-minted certs.
- `pki/agent-vm-ca.pem` — key + cert concatenated. `./agent` pushes
  this into the firewall VM at `/etc/agent-vm/agent-vm-ca.pem` (mode
  0600 root:root); systemd `LoadCredential` surfaces it to the
  mitmproxy services.

The CA is per-deployment (per-host, per-clone of this repo). Delete
`pki/` and re-provision to rotate.

### What still gets through

Full MITM closes the SNI-vs-upstream-IP and Host-vs-SNI gaps, but the
allowlist itself is the remaining attack surface:

- **Shared infrastructure.** Wildcards like `*.cloudfront.net` or
  `*.githubusercontent.com` are valid TLS hostnames an attacker can
  also obtain certs for — anything they can host on those CDNs becomes
  a working exfil channel even with MITM. Prefer specific hostnames
  to wildcards; for write-able user-content services (gists,
  Discord webhooks, Pastebin, etc.) consider whether you need them at
  all.
- **Covert channels in legitimate traffic** — timing, request order,
  encoded URLs to allowed read-only endpoints. Not preventable at the
  network layer.

### What's still on the to-do list

The firewall is solid against accidental egress and basic deliberate
exfil, but a few gaps remain:

- **QUIC / HTTP/3 (UDP 443).** Not intercepted; not currently dropped
  at the nftables level. Most clients fall back to TCP if UDP 443
  fails, but a deliberate one wouldn't.
- **DoH endpoints in the allowlist.** Any allowed DoH host
  (`cloudflare-dns.com`, `dns.google`, etc.) doubles as a DNS bypass
  and an exfil channel. Audit `allowed-https.txt` for these.
- **WebSocket frames** are passed through after the upgrade — Host
  matches on the upgrade request, but frame contents aren't inspected.

## Adding a host

Edit the relevant file and run `./agent allow` from the repo root. The
files are copied into the firewall VM and dnsmasq is reloaded; mitmproxy
picks up changes on its next event (no restart). End-to-end takes ~1s.

If a host needs both DNS resolution and HTTPS access (the common case),
add it to **both** `allowed-dns.txt` and `allowed-https.txt`. dnsmasq
matches by suffix, mitmproxy matches by `fnmatch` glob.

## File formats

### `allowed-https.txt`

HTTPS (TCP/443) only — matched against the TLS SNI in the ClientHello.
Cleartext HTTP is denied at the firewall, not allowlisted.

`fnmatch` glob, one per line. Comments start with `#`.

```
api.github.com         # exact host
*.githubusercontent.com   # one-segment wildcard
bedrock-runtime.*.amazonaws.com   # middle wildcard
```

### `allowed-ssh.txt`

Same format as `allowed-https.txt`, but matched against the CONNECT host
on port 22 (SSH has no SNI, so we can only check the CONNECT line).

### `allowed-dns.txt`

Plain hostnames (no globs). dnsmasq matches as a suffix, so listing
`github.com` lets `api.github.com` and `codeload.github.com` resolve.

## Debugging

```bash
# What's the firewall VM logging?
limactl shell firewall -- journalctl -u mitmproxy-explicit -u mitmproxy-transparent -u dnsmasq -f

# Is mitmproxy listening on both ports?
limactl shell firewall -- ss -tln '( sport = :8080 or sport = :8081 )'

# Is the NAT REDIRECT rule loaded?
limactl shell firewall -- sudo nft list table ip agent-vm-nat

# What's the agent VM seeing?
./agent -- curl -v https://example.com 2>&1 | head -20

# Allowlist content currently inside the VM:
limactl shell firewall -- cat /etc/agent-vm/allowed-https.txt
limactl shell firewall -- cat /etc/agent-vm/dnsmasq-allowlist.conf
```

## Files in this directory

- `allowed-https.txt.defaults` `allowed-ssh.txt.defaults`
  `allowed-dns.txt.defaults` — checked-in seed allowlists. `./agent`
  copies each to `<name>.txt` (gitignored) on first run.
- `allowed-https.txt` `allowed-ssh.txt` `allowed-dns.txt` — gitignored,
  user-editable live allowlists. The single source of truth at runtime.
- `mitmproxy_addon.py` — Python addon loaded by mitmdump. Reads the
  allowlist files from `/etc/agent-vm/` inside the firewall VM, with
  mtime-based hot reload.
- `reload.sh` — runs inside the firewall VM after `./agent allow` copies
  fresh allowlist files in. Regenerates dnsmasq's config and signals it.
- This README.
