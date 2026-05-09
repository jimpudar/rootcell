---
name: network-allowlist
description: When a network call fails with "could not resolve host" or "connection refused", or you need to know up-front whether a particular host is reachable from inside this VM.
---

# Network egress allowlist

This VM is sandboxed by an external firewall VM. Outbound traffic is
restricted to a host allowlist the user maintains on the host. The
allowlist files live on the host (not in this VM) at
`proxy/allowed-https.txt`, `proxy/allowed-ssh.txt`, and
`proxy/allowed-dns.txt` — you can't read them from in here.

## How denials look

- **DNS not allowlisted** → `dig <host>` returns `status: REFUSED`;
  `curl` / `git` fail with "Could not resolve host". Most common
  failure mode for unfamiliar domains.
- **HTTPS SNI not allowlisted** (DNS resolves, but mitmproxy denies
  the TLS handshake) → `curl` exits 35 or 60 with a TLS error. DNS
  worked but the SNI/Host didn't match.
- **SSH host not allowlisted** → `ssh git@host` fails with
  "Connection closed by remote host" or `kex_exchange_identification`.

These failures are deterministic. Don't retry — it won't work the
second time.

## To check whether a host is reachable

Probe it directly from inside this VM:

- `dig +short <host>` — empty / REFUSED means DNS-blocked.
- `curl -v --max-time 5 https://<host>` — TLS handshake errors after
  DNS succeeds means SNI-blocked.
- `ssh -o BatchMode=yes -o ConnectTimeout=5 -T git@<host>` — fast
  failure with "Connection closed" means SSH-blocked.

## To add a host

You can't change the allowlist from in here. Ask the user:

> Please add `<hostname>` to the relevant file(s) on the host:
> - `proxy/allowed-https.txt` — HTTPS / HTTP (SNI / Host header,
>   `fnmatch` globs; `*.example.com` matches subdomains, not the apex).
> - `proxy/allowed-ssh.txt` — SSH CONNECT-host (same glob format).
> - `proxy/allowed-dns.txt` — DNS suffixes (plain hostnames, suffix
>   match: `github.com` covers `api.github.com` too).
>
> Then run `./agent allow` from the repo root (hot-reload, ~1s).

A host that needs both DNS and HTTPS (the common case) has to go in
both `allowed-dns.txt` and `allowed-https.txt`.

## What won't help

- Setting `HTTPS_PROXY` / `HTTP_PROXY` env vars — the firewall is
  transparent at the network layer; the VM doesn't know about it and
  doesn't need to.
- Installing a custom CA — there is no MITM on the allow path; the
  proxy passes TLS through after checking the SNI.
- Retrying the same call — DNS REFUSED and SNI denial are fail-closed
  and won't change on their own.
