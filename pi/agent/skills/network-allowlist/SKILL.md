---
name: network-allowlist
description: When a network call fails with DNS, TLS, or SSH refusal, or to check up-front whether a host is reachable from this firewalled VM.
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
  the TLS handshake) → `curl` exits with a connection-reset / TLS
  error (commonly 35 or 56). DNS worked but the SNI didn't match.
- **HTTPS Host header doesn't agree with the SNI / connect target**
  → mitmproxy MITM-terminates the TLS, sees the request, and kills
  the flow → curl reports "Empty reply from server" (exit 52). Fix
  by using the same hostname in the URL as the TLS connection — don't
  override `Host:` to point at a different tenant on a shared CDN.
- **Cleartext HTTP** → always denied. The firewall doesn't proxy port
  80 at all (the HTTP Host header is unauthenticated), so `curl
  http://host` hangs until it times out. Use `https://` instead.
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
> - `proxy/allowed-https.txt` — HTTPS only (TLS SNI, `fnmatch` globs;
>   `*.example.com` matches subdomains, not the apex). Cleartext HTTP
>   is denied at the firewall and can't be allowlisted.
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
- Installing a custom CA — the firewall's per-deployment CA is
  already in this VM's system trust store. Adding more CAs has no
  effect on what the firewall accepts.
- Retrying the same call — DNS REFUSED and SNI denial are fail-closed
  and won't change on their own.

## Never use insecure / cert-skipping mode

If a TLS call fails with a cert verification error, **do not** retry
with `curl -k` / `--insecure`, `wget --no-check-certificate`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, `git -c http.sslVerify=false`,
`pip --trusted-host`, `GIT_SSL_NO_VERIFY=1`, Python `verify=False`,
or any equivalent.

Why: for allowlisted hosts, the firewall MITM-terminates TLS and
presents per-host certs minted by a per-deployment CA that's already
in this VM's trust store, AND it validates the upstream cert against
the SNI on the way out. So a cert verify failure inside this VM
either means (a) the SNI was rejected (common cause: the allowlist
entry is the apex `example.com` but you hit `www.example.com` —
fnmatch doesn't match across the dot, so add `*.example.com` too)
or (b) the upstream presented a cert that doesn't validate for the
hostname you asked for (i.e. someone is trying to MITM you, or DNS
returned the wrong IP). Bypassing verification papers over the wrong
problem in either case. Stop and ask the user.
