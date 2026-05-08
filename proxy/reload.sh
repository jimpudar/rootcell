#!/usr/bin/env bash
# Regenerate dnsmasq's allowlist from /etc/agent-vm/allowed-dns.txt and
# reload dnsmasq. mitmproxy reloads its own allowlists on mtime change,
# so it doesn't need a signal.
#
# Run inside the firewall VM by `./agent allow` on the host:
#   limactl shell firewall -- sudo /etc/agent-vm/reload.sh

set -euo pipefail

src=/etc/agent-vm/allowed-dns.txt
dst=/etc/agent-vm/dnsmasq-allowlist.conf
tmp=${dst}.new

# server=/HOST/UPSTREAM forwards HOST and its subdomains to UPSTREAM.
# address=/#/0.0.0.0 is dnsmasq's catch-all: any name not matched above
# returns 0.0.0.0, which acts as an effective NXDOMAIN for clients that
# treat unroutable answers as failure.
{
  while IFS= read -r line; do
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    echo "server=/$line/1.1.1.1"
  done < "$src"
  echo "address=/#/0.0.0.0"
} > "$tmp"

mv -f "$tmp" "$dst"

# `systemctl reload dnsmasq` sends SIGHUP, which only re-reads /etc/hosts
# and the leases file — NOT the --conf-file=$dst. To pick up the new
# server= lines we have to restart. dnsmasq comes back in milliseconds,
# and `./agent allow` is interactive so the blip is acceptable.
systemctl restart dnsmasq

echo "reload: dnsmasq reconfigured ($(wc -l < "$dst") lines); mitmproxy will pick up changes on its next event."
