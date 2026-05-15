#!/usr/bin/env bash
set -Eeuo pipefail

current_step="initializing"

on_error() {
  local status="$?"
  echo "::error::build-release failed while ${current_step}." >&2
  echo "::error::line ${BASH_LINENO[0]} exited with status ${status}: ${BASH_COMMAND}" >&2
  if [ -d dist ]; then
    echo "dist contents at failure:" >&2
    find dist -maxdepth 1 -type f -printf '  %f %s bytes\n' >&2 || true
  fi
  exit "$status"
}

trap on_error ERR

rm -rf dist work
mkdir -p dist work

current_step="evaluating pinned revisions"
ROOTCELL_REV="$(nix eval --raw .#rootcellSourceRevision)"
NIXPKGS_REV="$(nix eval --raw .#nixpkgsRevision)"

build_role() {
  local role="$1"
  local attr="$2"

  current_step="building $role image"
  echo "==> Building $role image ($attr)"
  rm -rf "result-$role" "work/$role.raw"
  nix build --print-build-logs --out-link "result-$role" ".#packages.aarch64-linux.$attr"

  current_step="locating $role image output"
  local img
  img="$(find -L "result-$role" -type f -name '*.img' -print -quit)"
  if [ -z "$img" ]; then
    echo "::error::no .img file found in result-$role" >&2
    find -L "result-$role" -maxdepth 3 -type f -printf '  %p\n' >&2
    return 1
  fi

  current_step="compressing $role image"
  cp --sparse=always "$img" "work/$role.raw"
  local raw_size
  raw_size="$(stat -c%s "work/$role.raw")"

  zstd -T0 -19 --rm "work/$role.raw" -o "dist/$role.raw.zst"

  local compressed_size sha
  compressed_size="$(stat -c%s "dist/$role.raw.zst")"
  sha="$(sha256sum "dist/$role.raw.zst" | cut -d ' ' -f1)"

  printf '%s %s %s\n' "$raw_size" "$compressed_size" "$sha" > "dist/$role.meta"
  rm -rf "result-$role"
  echo "==> Finished $role image"
}

build_role agent agentImage
build_role firewall firewallImage
build_role builder builderImage

agent_raw="$(cut -d ' ' -f1 dist/agent.meta)"
agent_compressed="$(cut -d ' ' -f2 dist/agent.meta)"
agent_sha="$(cut -d ' ' -f3 dist/agent.meta)"

firewall_raw="$(cut -d ' ' -f1 dist/firewall.meta)"
firewall_compressed="$(cut -d ' ' -f2 dist/firewall.meta)"
firewall_sha="$(cut -d ' ' -f3 dist/firewall.meta)"

builder_raw="$(cut -d ' ' -f1 dist/builder.meta)"
builder_compressed="$(cut -d ' ' -f2 dist/builder.meta)"
builder_sha="$(cut -d ' ' -f3 dist/builder.meta)"

current_step="writing manifest"
cat > dist/manifest.json <<JSON
{
  "schemaVersion": 1,
  "guestApiVersion": 1,
  "rootcellSourceRevision": "$ROOTCELL_REV",
  "nixpkgsRevision": "$NIXPKGS_REV",
  "rootcellCliContract": { "min": 1, "max": 1 },
  "images": [
    { "role": "agent", "architecture": "aarch64-linux", "fileName": "agent.raw.zst", "url": "agent.raw.zst", "compression": "zstd", "compressedSize": $agent_compressed, "rawSize": $agent_raw, "sha256": "$agent_sha" },
    { "role": "firewall", "architecture": "aarch64-linux", "fileName": "firewall.raw.zst", "url": "firewall.raw.zst", "compression": "zstd", "compressedSize": $firewall_compressed, "rawSize": $firewall_raw, "sha256": "$firewall_sha" },
    { "role": "builder", "architecture": "aarch64-linux", "fileName": "builder.raw.zst", "url": "builder.raw.zst", "compression": "zstd", "compressedSize": $builder_compressed, "rawSize": $builder_raw, "sha256": "$builder_sha" }
  ]
}
JSON

rm -f dist/*.meta
echo "==> Release assets are ready in dist/"
