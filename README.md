# lima-pi-vm

Disposable NixOS Lima VMs, declaratively configured, with [pi](https://pi.dev)
as the only coding agent installed. A single host-side script (`./agent`)
handles everything: VM lifecycle, provisioning, key injection, and the
egress firewall.

The architecture is **two VMs**: an **agent VM** where `pi` runs with full
root, and a tiny **firewall VM** that brokers all egress through mitmproxy
(SNI allowlist) and dnsmasq (DNS allowlist). The agent VM has no network
path to the public internet except through the firewall VM.

**HTTPS/HTTP egress is transparent** — the agent VM has no proxy env vars
configured; the firewall intercepts TCP/80 and TCP/443 with nftables NAT
REDIRECT, then mitmproxy reads the SNI / Host header and applies the
allowlist. Plain `curl https://github.com` Just Works (or doesn't,
transparently).

**SSH egress is explicit** because SSH has no SNI and we want hostname-level
allowlisting. The agent VM's `~/.ssh/config` (set declaratively via
home-manager) tunnels every SSH connection through mitmproxy via HTTP
CONNECT. Allowlists live in the repo and hot-reload via `./agent allow`.

## Layout

```
agent              # host entry point: brings both VMs up, provisions, execs in
flake.nix          # inputs (nixpkgs, nixos-lima, home-manager) + outputs
common.nix         # shared NixOS config (boot/fs, lima, nix, user)
agent-vm.nix       # agent VM: networking through the firewall, no v6, no NAT
firewall-vm.nix    # firewall VM: mitmproxy + dnsmasq systemd services
home.nix           # Home Manager config: pi + dev CLIs (agent VM only)
nixos.yaml         # Lima config for the agent VM (lima:host network only)
firewall.yaml      # Lima config for the firewall VM (vzNAT + lima:host)
.env.defaults      # checked-in defaults (AWS_REGION, network IPs); seeds .env on first run
network.nix        # default IPs/subnet for the inter-VM link (overridable via .env)
pkgs/socket_vmnet.nix  # Nix derivation for socket_vmnet (not in nixpkgs)
proxy/             # the egress firewall — see proxy/README.md:
  allowed-https.txt#   SNI allowlist (fnmatch globs)
  allowed-ssh.txt  #   SSH CONNECT-host allowlist
  allowed-dns.txt  #   DNS suffix allowlist (dnsmasq)
  mitmproxy_addon.py #  mitmproxy addon implementing the SNI check
  reload.sh        #   hot-reload helper (runs inside the firewall VM)
pi/agent/          # mirrors ~/.pi/agent/ in the agent VM (home-manager symlinks):
  AGENTS.md        #   pi global instructions
  skills/          #   pi global skills (one dir per skill, each with SKILL.md)
```

The two `*.yaml` Lima configs are self-contained — not `base:` overlays.
The nixos-lima qcow2 URL and SHA512 digest are pinned inline so updates
are explicit, and `mounts: []` disables Lima's default host-home mount so
neither VM can see the host filesystem.

## One-time host setup

You need [Lima](https://lima-vm.io) and [Nix](https://nixos.org/download)
installed on your Mac. (`./agent` uses Nix to build `socket_vmnet` — see
the next subsection — so Nix is non-optional now.)

Three one-time things to set up. The `agent` script prints exact, paste-able
commands the first time anything's missing, so you can also just run
`./agent` and follow the prompts.

### 1. Install `socket_vmnet`

The `lima: host` shared network — the link between the agent VM and the
firewall VM — uses macOS's `vmnet.framework`, which requires a privileged
helper called `socket_vmnet`. Lima expects it at `/opt/socket_vmnet/bin/`
so its sudoers grant has a stable, secure target.

`socket_vmnet` isn't in nixpkgs as of writing, so this repo packages it
itself ([pkgs/socket_vmnet.nix](pkgs/socket_vmnet.nix)) and exposes it as
a flake package. The binary you copy is therefore Nix-built (immutable,
root-owned in the Nix store, byte-for-byte reproducible) — but macOS won't
let any non-root tool write under `/opt`, so the copy itself must be
`sudo`. **This is the only imperative step in the whole setup.**

`./agent` will print the exact `sudo install` command on first run with
the right Nix-store path filled in. The pattern looks like:

```bash
nix build .#socket_vmnet                                   # builds via flake
sudo install -m 0755 -d /opt/socket_vmnet/bin
sudo install -m 0755 result/bin/* /opt/socket_vmnet/bin/   # the imperative bit
```

After this, `socket_vmnet` lives at `/opt/socket_vmnet/bin/socket_vmnet`,
identical to a `make install` from upstream, and Lima recognises it. To
upgrade later, bump `version` and `hash` in `pkgs/socket_vmnet.nix` and
re-run the same `sudo install` — `./agent` will detect the mismatch and
prompt.

### 2. Grant Lima sudo access for `socket_vmnet`

```bash
limactl sudoers | sudo tee /private/etc/sudoers.d/lima
```

This generates a NOPASSWD rule scoped to `/opt/socket_vmnet/bin/socket_vmnet`
so Lima can invoke the helper without prompting per VM start.

### 3. Stash your provider key in the macOS Keychain

```bash
security add-generic-password -a "$USER" -s aws-bedrock-api-key -w "<your-key>"
chmod +x ./agent
```

The script is wired for **AWS Bedrock** (it exports `AWS_BEARER_TOKEN_BEDROCK`
and `AWS_REGION` into the agent VM). On first run, `./agent` copies
`.env.defaults` to `.env` (gitignored) and sources it on every subsequent
invocation. Edit `.env` to change the region or add other env vars — for
example:

```
AWS_REGION=us-west-2
```

If you use a different provider, edit `agent` — the Keychain lookup name
and the env vars exported are the only other assumptions baked in.

## Daily use

```bash
./agent                        # drop into a bash shell inside the agent VM
./agent pi                     # run pi directly
./agent -- nix flake update    # any command, in the agent VM
./agent allow                  # hot-reload the allowlists into the firewall VM
                               # (after editing proxy/allowed-*.txt)
```

On first run, `./agent`:

1. Brings up the firewall VM and rebuilds it (mitmproxy + dnsmasq).
2. Syncs the allowlists in and waits for the services to be listening.
3. Brings up the agent VM and rebuilds it through the firewall.
4. Activates home-manager (installs pi).
5. Execs in.

End-to-end first run is ~15 minutes (firewall + agent rebuilds + home-manager
fetches all flow through mitmproxy). Subsequent runs are seconds.

## Egress firewall

Anything the agent VM tries to reach must go through the firewall VM. The
allowlists live in [proxy/](proxy/):

- **`allowed-https.txt`** — SNI/Host allowlist for HTTPS and HTTP. For
  HTTPS, mitmproxy reads the TLS ClientHello and matches the SNI against
  `fnmatch` globs (one per line). For HTTP, the Host header is checked
  the same way. Strict — even an allowed destination IP can't bypass by
  spoofing the SNI/Host.
- **`allowed-ssh.txt`** — SSH CONNECT-host allowlist. SSH has no SNI, so
  this is matched against the `CONNECT host:22` line that the agent VM's
  SSH `ProxyCommand` sends. Used for `git clone git@github.com:...` and
  similar.
- **`allowed-dns.txt`** — DNS suffix allowlist. dnsmasq forwards matching
  names to 1.1.1.1; everything else returns `0.0.0.0`.

To add a host, edit the relevant file(s) and run `./agent allow`. Reload
takes ~1s and doesn't restart any services. See [proxy/README.md](proxy/README.md)
for ops notes (logs, debugging, file formats).

If a host needs both DNS resolution and HTTPS access (the common case),
add it to **both** `allowed-dns.txt` and `allowed-https.txt`.

## After editing config

Whenever you change `flake.nix`, `common.nix`, `agent-vm.nix`,
`firewall-vm.nix`, `home.nix`, or anything under `pi/`:

```bash
./agent provision
```

This re-copies the files into the relevant VM(s) and re-runs `nixos-rebuild
switch` (and home-manager for the agent VM). Fast on subsequent provisions
because the Nix store is cached.

For allowlist edits only, prefer `./agent allow` — it skips the full
rebuild.

## Spin up / tear down

For a fully ephemeral run (clean slate every time):

```bash
limactl delete agent firewall --force
./agent                       # next invocation provisions both VMs from scratch
```

For a faster cycle (keeps the Nix store cache, just stops the VMs):

```bash
limactl stop agent firewall
./agent                       # restarts both and execs into agent
```

## Running on multiple macOS user accounts

The default inter-VM network is `192.168.106.0/24` with the firewall VM
at `.1` and the agent VM at `.2`. Lima implements `lima:host` networks
on macOS via `socket_vmnet`, which talks to the kernel's `vmnet.framework`
to create a bridge interface — and **those bridges are system-wide, not
per-user**. If two macOS user accounts both run this project with the
defaults, they fight for the same subnet: VMs from one account end up on
the same L2 segment as the other, IPs collide, dnsmasq replies cross
between accounts, etc.

To run on two accounts simultaneously, give the second account a
different network. **All four steps must happen in the second account.**

### 1. Add a new Lima network entry

Edit `~/.lima/_config/networks.yaml` (it's per-user, so this won't
affect the first account). Add a new host-mode entry next to the
defaults — pick any unused private subnet:

```yaml
networks:
  # ... keep the existing host / shared / bridged entries that Lima
  # ships with ...

  host2:
    mode: host
    gateway: 192.168.107.1
    netmask: 255.255.255.0
```

The name (`host2` here) is what you'll reference in `.env`. Subnet must
not overlap any other entry on this Mac.

### 2. Override the four network variables in `.env`

`./agent` seeds `.env` from `.env.defaults` on first run. Edit `.env`
(it's gitignored, so per-account customization stays out of git):

```sh
LIMA_NETWORK=host2
FIREWALL_IP=192.168.107.1
AGENT_IP=192.168.107.2
NETWORK_PREFIX=24
```

`FIREWALL_IP` must equal the `gateway` you set in step 1. `AGENT_IP`
must be a different host inside the same subnet. These four variables
drive every IP reference in the project: the host script (which IP to
poll for liveness, which Lima named-network to pass to `limactl start`)
and the NixOS modules (via the auto-generated `network-local.nix` —
gitignored, regenerated by `./agent` on every invocation).

### 3. Delete any pre-existing VMs in this account

Lima caches the network name at VM-create time (it copies the YAML to
`~/.lima/<name>/lima.yaml`), and the IPs are baked into the NixOS
configuration that's already activated inside the VM. So a network
change requires recreating both VMs:

```bash
limactl delete agent firewall --force
```

### 4. Run `./agent`

Both VMs come up on the new subnet. They won't see the first account's
VMs at all because they're on a separate vmnet bridge.

### What about the project-wide defaults?

Defaults (`192.168.106.0/24`, etc.) live in two places:

- [`network.nix`](network.nix) — defaults the NixOS modules see if
  `network-local.nix` doesn't exist (e.g., `nix flake check` outside
  the agent script).
- [`.env.defaults`](.env.defaults) — what `./agent` seeds new `.env`
  files with.

Both should agree. Change them together if you want to shift the
project-wide default subnet.

## Customizing

- **Adjust hardware**: Lima copies `nixos.yaml` (and `firewall.yaml`) into
  `~/.lima/<name>/lima.yaml` at VM creation and reads from that copy on every
  subsequent start, so editing the in-repo files alone has no effect on an
  existing VM. Either run `limactl edit <name>` or
  `limactl delete <name> --force && ./agent` for a clean rebuild.
- **Add or change tools**: edit `home.packages` in `home.nix`, then
  `./agent provision`. Fast.
- **Change OS-level config** of the agent VM: edit `agent-vm.nix` (or
  `common.nix` for things shared with the firewall), then `./agent provision`.
- **Change firewall services**: edit `firewall-vm.nix`, then `./agent provision`.
- **Change architecture**: three files in lockstep. Flip `system` in
  `flake.nix` to `"x86_64-linux"`, update the pi tarball URL in `home.nix`
  to match (e.g. `pi-linux-x64.tar.gz`, plus its sha256), and replace the
  image URL / `arch` / `digest` in both `nixos.yaml` and `firewall.yaml`
  with the matching x86_64 qcow2 from the same nixos-lima release.
- **Change username**: edit `username` in `flake.nix` **and** `GUEST_USER`
  in `agent` so they agree.
- **Update pi**: in `home.nix`, bump `version` in the `pi-coding-agent`
  derivation. After bumping, the next `./agent provision` will fail with
  a hash mismatch — copy the "got: sha256-..." value into the `sha256`
  field and re-run. Latest release at
  https://github.com/badlogic/pi-mono/releases.

## Customizing pi

Everything under `pi/agent/` on the host is symlinked into `~/.pi/agent/`
in the agent VM, so the host layout mirrors the guest layout one-to-one.

`pi/agent/AGENTS.md` lands at `~/.pi/agent/AGENTS.md`, which pi loads as
global instructions on every session. Keep it short — its full body goes
into the system prompt.

`pi/agent/skills/` lands at `~/.pi/agent/skills/`, so each
`pi/agent/skills/<name>/SKILL.md` is reachable at
`~/.pi/agent/skills/<name>/SKILL.md`. Pi treats those as
[skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md):
the frontmatter `description` goes into the system prompt, and the body
loads on demand when a task matches. Add new skills by dropping more
directories under `pi/agent/skills/` and running `./agent provision`.

Per-project rules go in an `AGENTS.md` or `CLAUDE.md` at the project's
repo root. Pi finds them by walking up from the cwd, and merges them with
the global file.

## How pi gets installed

Pi ships a Bun-compiled standalone binary on each GitHub release, so we
fetch the release tarball directly via `pkgs.fetchurl` and wrap it in a
small `stdenv.mkDerivation`. `autoPatchelfHook` rewrites the binary's ELF
interpreter to point at glibc inside the Nix store (NixOS has no
`/lib64/ld-linux-aarch64.so.1`), and the runtime resources that ship
alongside `pi` (theme, export-html, wasm, `package.json`) are copied as
siblings under `$out/share/pi-coding-agent/` so the binary can find them.

Net result: pi is a fully declarative, fully reproducible Nix package,
pinned by SHA256. No Node.js, no npm, no impure activation step.

## Git config passthrough

On every `./agent provision`, the script reads your host's
`git config --global user.{name,email}` and writes a one-off `git-local.nix`
that home-manager imports. Commits inside the agent VM are attributed to
you, not to a generic placeholder. The generated file is `.gitignore`d.

## Secrets

`./agent` reads the Bedrock key from Keychain on each invocation and
injects it as `AWS_BEARER_TOKEN_BEDROCK` into the agent VM's environment.
The key is never written to disk inside the VM and never enters the Nix
store.

If you switch providers, change the Keychain service name and the env-var
name in `agent`. Keep the principle: read from Keychain, export at exec
time, never persist.

Don't put any provider key in `home.nix` — the Nix store is world-readable.

## Linux portability

The architecture transfers cleanly. On Linux, change `vmType: vz` →
`vmType: qemu` (or omit for Lima default) and `vzNAT: true` →
`lima: user-v2` in `firewall.yaml`. Everything else is identical because
Lima abstracts the network backend and `ssh.overVsock` works on
qemu+vhost-vsock too.
