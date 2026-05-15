#!/usr/bin/env bash
set -euo pipefail

dir="${1:-dist}"

for file in manifest.json agent.raw.zst firewall.raw.zst builder.raw.zst; do
  test -f "$dir/$file"
done

DIST_DIR="$dir" node <<'JS'
const fs = require("fs");
const path = require("path");

const dir = process.env.DIST_DIR || "dist";
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const roles = new Set(manifest.images.map((i) => i.role));
for (const role of ["agent", "firewall", "builder"]) {
  if (!roles.has(role)) throw new Error(`missing role ${role}`);
}
if (manifest.schemaVersion !== 1) throw new Error("bad schemaVersion");
if (manifest.guestApiVersion !== 1) throw new Error("bad guestApiVersion");
if (manifest.rootcellCliContract.min !== 1 || manifest.rootcellCliContract.max !== 1) {
  throw new Error("bad rootcellCliContract");
}
for (const image of manifest.images) {
  if (image.architecture !== "aarch64-linux") throw new Error(`bad arch for ${image.role}`);
  if (image.compression !== "zstd") throw new Error(`bad compression for ${image.role}`);
  if (!/^[0-9a-f]{64}$/.test(image.sha256)) throw new Error(`bad sha for ${image.role}`);
}
JS

for role in agent firewall builder; do
  expected="$(node -e "const m=require('./$dir/manifest.json'); console.log(m.images.find(i=>i.role==='${role}').sha256)")"
  actual="$(sha256sum "$dir/$role.raw.zst" | cut -d ' ' -f1)"
  test "$expected" = "$actual"
done
