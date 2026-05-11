#!/usr/bin/env bash
# Regenerate dnsmasq's allowlist from /etc/agent-vm/allowed-dns.txt and
# reload dnsmasq. mitmproxy reloads its own allowlists on mtime change,
# so it doesn't need a signal.
#
# Run inside the firewall VM by `./rootcell allow` on the host:
#   limactl shell firewall -- sudo /etc/agent-vm/reload.sh

set -euo pipefail

src=/etc/agent-vm/allowed-dns.txt
dst=/etc/agent-vm/dnsmasq-allowlist.conf
tmp=${dst}.new

# server=/HOST/UPSTREAM forwards HOST and its subdomains to UPSTREAM.
# We deliberately do NOT add an `address=/#/0.0.0.0` catch-all: dnsmasq
# evaluates address= rules BEFORE server= rules regardless of specificity,
# so a wildcard address= would short-circuit every server= above and
# return 0.0.0.0 for allowlisted names too. With no-resolv set in the
# main config and no default `server=` line here, queries for any name
# not matched below fail with REFUSED — that's our fail-closed default.
{
  while IFS= read -r line; do
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    echo "server=/$line/1.1.1.1"
  done < "$src"
} > "$tmp"

mv -f "$tmp" "$dst"

# `systemctl reload dnsmasq` sends SIGHUP, which only re-reads /etc/hosts
# and the leases file — NOT the --conf-file=$dst. To pick up the new
# server= lines we have to restart. dnsmasq comes back in milliseconds,
# and `./rootcell allow` is interactive so the blip is acceptable.
systemctl restart dnsmasq

echo "reload: dnsmasq reconfigured ($(wc -l < "$dst") lines); mitmproxy will pick up changes on its next event."
