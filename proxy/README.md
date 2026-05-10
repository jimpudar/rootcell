# proxy/

The egress firewall for the agent VM. All outbound traffic from the agent
VM passes through services running in the firewall VM:

- **mitmproxy (transparent)** at `192.168.106.2:8081` — receives TCP/443
  packets that nftables NAT REDIRECT intercepts on the inter-VM link.
  Reads the TLS SNI from the ClientHello and matches against
  `allowed-https.txt`. Passthrough on allow (no MITM, no CA in the agent
  VM); deny redirects upstream to `127.0.0.1:1` so the client
  TCP-handshake gets RST and the real upstream sees nothing.
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
stays explicit so we can allowlist by hostname.

The three allowlist files are gitignored; `./agent` seeds each from its
`.defaults` sibling on first run. Edit the live `*.txt` to customize;
delete the live file and re-run `./agent` to reset to project defaults.

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
