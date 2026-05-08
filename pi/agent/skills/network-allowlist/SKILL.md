---
name: network-allowlist
description: When a network call fails with "could not resolve host" or "connection refused", or you need to know up-front whether a particular host is reachable from inside this VM.
---

# Network egress allowlist

This VM is sandboxed by an external firewall VM. Outbound traffic is
restricted to hosts the user has explicitly allowlisted. The current
rules live in three plain-text files at the repo root:

- `/home/luser/lima-pi-vm/proxy/allowed-https.txt` — HTTPS / HTTP hosts.
  Matched by SNI / Host header against `fnmatch` globs (so a leading
  `*.example.com` matches subdomains).
- `/home/luser/lima-pi-vm/proxy/allowed-ssh.txt` — hosts you may reach
  over SSH (e.g. for `git clone git@host:...`).
- `/home/luser/lima-pi-vm/proxy/allowed-dns.txt` — DNS suffixes that
  resolve at all. Anything outside this list returns REFUSED.

Read those files to see what's currently allowed. They're authoritative
and update at runtime — not stale.

## To add a host

You can't change them from inside this VM. Ask the user to:

1. Edit the relevant file(s) at the repo root on the host.
2. Run `./agent allow` from the repo root (hot-reload, ~1 second).

If the host needs both DNS and HTTPS (the common case), it has to go in
both `allowed-dns.txt` and `allowed-https.txt`.

## What won't help

- Setting `HTTPS_PROXY` / `HTTP_PROXY` env vars — the firewall is
  transparent at the network layer; the VM doesn't know about it and
  doesn't need to.
- Installing a custom CA — there is no MITM; the proxy passes TLS
  through after checking the SNI.
- Retrying the same call — DNS REFUSED is fail-closed and won't change
  on its own.
