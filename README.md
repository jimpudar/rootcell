# lima-pi-vm

Disposable NixOS Lima VM, declaratively configured, with [pi](https://pi.dev)
as the only coding agent installed.

## Layout

```
flake.nix          # inputs (nixpkgs, nixos-lima, home-manager) + outputs
configuration.nix  # NixOS system config: dev tooling + pi runtime deps
home.nix           # Home Manager config: installs pi + dev CLIs
nixos.yaml         # Lima config: inherits upstream image, hardcodes hardware
```

The `nixos.yaml` inherits the base image and lima-guestagent setup from
upstream nixos-lima (via Lima's `base:` field) and overrides only the
hardware allocation locally — so memory/CPU are pinned in-repo while
image updates still flow through.

## One-time setup on the host

You need Lima installed on your Mac (`brew install lima` or via Nix).
You do NOT need Nix on the host — all Nix work happens inside the guest.

## Bring the VM up

```bash
# 1. Boot the VM using our pinned config.
limactl start --name=agent --set '.user.name = "luser"' ./nixos.yaml

# 2. Drop into the VM. From here on, everything runs inside the guest.
limactl shell agent

# 3. Inside the VM: clone this repo (or copy it via the Lima home mount).
git clone <your-fork-of-this-repo> ~/lima-pi-vm
cd ~/lima-pi-vm

# 4. Switch the system to our config.
sudo nixos-rebuild switch --flake .#agent-vm

# 5. Switch the user environment (this is what installs pi).
nix run nixpkgs#home-manager -- switch --flake .#lima

# 6. Set your provider key, then run the agent.
export ANTHROPIC_API_KEY=sk-...
pi
```

After step 5, `pi` is on your PATH via the Nix store (a symlink in
`~/.nix-profile/bin/pi`).

## The "spin up / tear down" loop

For a fully ephemeral run (clean slate every time):

```bash
limactl delete agent --force        # blow it away
limactl start --name=agent ./nixos.yaml
# ...repeat steps 2–5 above
```

For a faster cycle (keeps Nix store cache, just stops the VM):

```bash
limactl stop agent
limactl start agent
```

The first delete-and-recreate takes a few minutes (download base image,
fetch nixpkgs, build closure, fetch pi release tarball). Subsequent
rebuilds in the same VM are fast because the Nix store is cached.

## Customizing

- **Adjust hardware**: edit `memory`, `cpus`, `disk` in `nixos.yaml`, then
  `limactl stop agent && limactl start agent` (some changes require
  `limactl delete` + recreate).
- **Add or change tools**: edit `home.packages` in `home.nix`, then
  `home-manager switch --flake .#lima`. Fast.
- **Change OS-level config** (sudo, nix daemon, users, services): edit
  `configuration.nix`, then `sudo nixos-rebuild switch --flake .#agent-vm`.
  Slower; usually unnecessary.
- **Change architecture**: flip `system` in `flake.nix` to `"x86_64-linux"`
  if you're not on Apple Silicon.
- **Change username**: edit `username` in `flake.nix` AND pass
  `--set '.user.name = "<name>"'` to `limactl start` so the Lima-created
  user matches.
- **Update pi**: in `home.nix`, bump `version` in the `pi-coding-agent`
  derivation and update `sha256` to match. Get the new hash with
  `nix-prefetch-url <release-url>` or by computing it from the downloaded
  tarball (`sha256sum pi-linux-arm64.tar.gz`). Latest release at
  https://github.com/badlogic/pi-mono/releases.

## How pi gets installed

Pi ships a Bun-compiled standalone binary on each GitHub release, so we
fetch the release tarball directly via `pkgs.fetchurl` and wrap it in a
small `stdenv.mkDerivation`. `autoPatchelfHook` rewrites the binary's
ELF interpreter to point at glibc inside the Nix store (NixOS doesn't
have `/lib64/ld-linux-aarch64.so.1`), and the runtime assets that ship
alongside `pi` (theme, export-html, wasm) are kept as siblings under
`$out/share/pi-coding-agent/` so the binary can find them.

Net result: pi is a fully declarative, fully reproducible Nix package,
pinned by SHA256. No Node.js, no npm, no impure activation step.

## Secrets

Don't put `ANTHROPIC_API_KEY` (or any other provider key) in `home.nix` —
the Nix store is world-readable. Either:

1. Export it in your shell each session (simplest).
2. Put it in `~/.config/pi/...` inside the VM and let pi read it.
3. Forward it from the host via Lima's `env` config in a custom YAML.
