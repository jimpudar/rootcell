# lima-pi-vm

Disposable NixOS Lima VM, declaratively configured, with [pi](https://pi.dev)
as the only coding agent installed. A single host-side script (`./agent`)
handles everything: VM lifecycle, provisioning, and key injection.

## Layout

```
agent              # host entry point: brings the VM up, provisions it, execs in
flake.nix          # inputs (nixpkgs, nixos-lima, home-manager) + outputs
configuration.nix  # NixOS system config: bootloader, lima integration, users
home.nix           # Home Manager config: pi + dev CLIs
nixos.yaml         # Lima config: image pin, hardware, mounts, port forwards
AGENTS.md          # Pi global instructions; symlinked into ~/.pi/agent/
skills/            # Pi global skills; the directory itself is symlinked
                   # into ~/.pi/agent/skills/
```

`nixos.yaml` is a self-contained Lima config — not a `base:` overlay. The
nixos-lima qcow2 URL and SHA512 digest are pinned inline so updates are
explicit, and `mounts: []` disables Lima's default host-home mount so the
VM can't see the host filesystem. The lima-guestagent isn't pulled in by
this file; it's enabled by the `nixos-lima.nixosModules.lima` import in
`configuration.nix`. To pick up a newer nixos-lima image, update the URL
and digest in `nixos.yaml` and bump the `nixos-lima` flake input together.

## One-time host setup

You need [Lima](https://lima-vm.io) installed on your Mac (`brew install lima`
or via Nix). You do **not** need Nix on the host — all Nix work happens inside
the guest.

Stash your provider key in the macOS Keychain so `./agent` can read it on each
invocation:

```bash
security add-generic-password -a "$USER" -s aws-bedrock-api-key -w "<your-key>"
chmod +x ./agent
```

The script is wired for **AWS Bedrock** (it exports `AWS_BEARER_TOKEN_BEDROCK`
and `AWS_REGION` into the VM, defaulting the latter to `us-east-2`). If you
use a different provider, edit `agent` — the Keychain lookup name, the env
vars exported, and the region default are the only assumptions baked in.

## Daily use

```bash
./agent                        # drop into a bash shell inside the VM
./agent pi                     # run pi directly
./agent -- nix flake update    # any command, in the VM
```

On first run, `./agent` boots the VM, copies the repo's config files into it,
runs `nixos-rebuild switch` and `home-manager switch`, and waits for pi to
land — about 10 minutes. On every subsequent run it just execs into the
already-provisioned VM with the API key in the env.

## After editing config

Whenever you change `flake.nix`, `configuration.nix`, `home.nix`, `AGENTS.md`,
or anything under `skills/`:

```bash
./agent provision
```

This re-copies the files into the VM and re-runs `nixos-rebuild switch` and
`home-manager switch`. Fast on subsequent provisions because the Nix store is
cached.

## Spin up / tear down

For a fully ephemeral run (clean slate every time):

```bash
limactl delete agent --force
./agent                       # next invocation provisions from scratch
```

For a faster cycle (keeps the Nix store cache, just stops the VM):

```bash
limactl stop agent
./agent                       # restarts and execs in
```

## Customizing

- **Adjust hardware**: Lima copies `nixos.yaml` into `~/.lima/agent/lima.yaml`
  at VM creation and reads from that copy on every subsequent start, so
  editing the in-repo `nixos.yaml` alone has no effect on an existing VM.
  Either run `limactl edit agent` (opens `$EDITOR` on the in-place copy) or
  `limactl delete agent --force && ./agent` for a clean rebuild. Update the
  in-repo `nixos.yaml` too so the next from-scratch provision matches.
- **Add or change tools**: edit `home.packages` in `home.nix`, then
  `./agent provision`. Fast.
- **Change OS-level config** (sudo, nix daemon, users, services): edit
  `configuration.nix`, then `./agent provision`. Slower; usually unnecessary.
- **Change architecture**: three files in lockstep. Flip `system` in
  `flake.nix` to `"x86_64-linux"`, update the pi tarball URL in `home.nix`
  to match (e.g. `pi-linux-x64.tar.gz`, plus its sha256), and replace the
  image URL / `arch` / `digest` in `nixos.yaml` with the matching x86_64
  qcow2 from the same nixos-lima release.
- **Change username**: edit `username` in `flake.nix` **and** `GUEST_USER`
  in `agent` so they agree.
- **Update pi**: in `home.nix`, bump `version` in the `pi-coding-agent`
  derivation. After bumping, the next `./agent provision` will fail with
  a hash mismatch — copy the "got: sha256-..." value into the `sha256`
  field and re-run. Latest release at
  https://github.com/badlogic/pi-mono/releases.

## Customizing pi

`AGENTS.md` is symlinked into `~/.pi/agent/AGENTS.md`, which pi loads as
global instructions on every session. Keep it short — its full body goes into
the system prompt.

The whole `skills/` directory is symlinked into `~/.pi/agent/skills/`, so each
`skills/<name>/SKILL.md` is reachable at `~/.pi/agent/skills/<name>/SKILL.md`.
Pi treats those as [skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md):
the frontmatter `description` goes into the system prompt, and the body loads
on demand when a task matches. Add new skills by dropping more directories
under `skills/` and running `./agent provision`.

Per-project rules go in an `AGENTS.md` or `CLAUDE.md` at the project's repo
root. Pi finds them by walking up from the cwd, and merges them with the
global file.

## How pi gets installed

Pi ships a Bun-compiled standalone binary on each GitHub release, so we fetch
the release tarball directly via `pkgs.fetchurl` and wrap it in a small
`stdenv.mkDerivation`. `autoPatchelfHook` rewrites the binary's ELF interpreter
to point at glibc inside the Nix store (NixOS has no `/lib64/ld-linux-aarch64.so.1`),
and the runtime resources that ship alongside `pi` (theme, export-html, wasm,
`package.json`) are copied as siblings under `$out/share/pi-coding-agent/` so
the binary can find them.

Net result: pi is a fully declarative, fully reproducible Nix package, pinned
by SHA256. No Node.js, no npm, no impure activation step.

## Git config passthrough

On every `./agent provision`, the script reads your host's
`git config --global user.{name,email}` and writes a one-off `git-local.nix`
that home-manager imports. Commits inside the VM are attributed to you, not
to a generic placeholder. The generated file is `.gitignore`d.

## Secrets

`./agent` reads the Bedrock key from Keychain on each invocation and injects
it as `AWS_BEARER_TOKEN_BEDROCK` into the VM's environment. The key is never
written to disk inside the VM and never enters the Nix store.

If you switch providers, change the Keychain service name and the env-var
name in `agent`. Keep the principle: read from Keychain, export at exec time,
never persist.

Don't put any provider key in `home.nix` — the Nix store is world-readable.
