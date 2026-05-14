# rootcell

[![build](https://img.shields.io/github/actions/workflow/status/rootcell-ai/rootcell/ci.yml?branch=main&style=flat-square&label=build)](https://github.com/rootcell-ai/rootcell/actions/workflows/ci.yml)

Give the agent root in the cell, not on your host.

rootcell gives a coding agent a disposable local VM where it can use root without
touching your host filesystem. All outbound traffic passes through a separate
firewall VM with DNS, HTTPS, and SSH allowlists. HTTPS is routed through a
transparent decrypting proxy, so rootcell can enforce host policy and
`./rootcell spy` can show formatted Bedrock Runtime traffic when you need to see
what the agent is sending.

## Current Scope

rootcell is early and intentionally narrow. Today it targets:

- **Host OS:** macOS hosts.
- **LLM provider:** Amazon Bedrock / Bedrock Runtime.
- **Coding harness:** [Pi](https://pi.dev) inside the agent VM.

The agent and firewall environments are NixOS VMs, but the host-side lifecycle,
networking, Keychain integration, and VM lifecycle currently assume macOS.

## Why This Exists

Coding agents are most useful when they can run commands, install tools, and edit
files. That's a lot of trust to hand to a process with network access.

rootcell gives you a local workspace where an agent can exercise root inside the
VM without receiving broad access to your Mac:

- A fresh NixOS VM for the agent's shell and tools.
- No default host-home mount from Lima.
- A separate firewall VM with the only public internet route.
- DNS, HTTPS, and SSH allowlists you can review and hot-reload.
- A per-VM SSH key for Git pushes.
- Provider secrets read from macOS Keychain at runtime, not stored in the VM or
  the Nix store.

Use it when you want the agent to go wild inside the VM, while keeping
an explicit network boundary around the work.

## How It Works

```mermaid
flowchart LR
  Host["macOS host<br/>repo, Keychain, ./rootcell"] -->|SSH| Firewall["firewall VM<br/>dnsmasq, mitmproxy"]
  Host -->|SSH ProxyJump through firewall| Agent["agent VM<br/>NixOS, pi, dev tools"]
  Agent -->|DNS, HTTPS, SSH| Firewall["firewall VM<br/>dnsmasq, mitmproxy"]
  Firewall -->|allowlisted egress| Internet["internet"]
```

The two VMs have different jobs:

| Piece | What it does |
| --- | --- |
| `agent` VM | Runs `pi`, shell commands, Git, build tools, and project work. It has root inside the VM, but no direct public internet route. |
| `firewall` VM | Owns the public egress path. It runs `dnsmasq` for DNS allowlisting and `mitmproxy` for HTTPS interception and SSH CONNECT policy. |
| `./rootcell` | Host-side wrapper that creates, provisions, updates, and enters the VMs. It also syncs allowlists and injects configured provider secrets for each session. |

Rootcell supports named instances. Plain `./rootcell` uses the `default`
instance and creates VMs named `agent` and `firewall`. `./rootcell --instance
dev` creates `agent-dev` and `firewall-dev`, with separate CA material,
allowlists, Keychain mappings, and a separate vmnet network.

HTTPS egress is transparent from inside the agent VM. A normal command like
`curl https://github.com` either works because the host is allowlisted, or fails
because the firewall denies it. SSH is explicit because SSH has no SNI; the
agent VM's SSH config tunnels it through the firewall so hostnames can still be
allowlisted.

Cleartext HTTP is denied. All egress is expected to be HTTPS or SSH.

## Quick Start

You need:

- macOS with [vfkit](https://github.com/crc-org/vfkit) available through Nix.
- [Nix](https://nixos.org/download) installed.
- [Bun](https://bun.sh) installed.
- Amazon Bedrock credentials stored in macOS Keychain.

The default VM build targets Apple Silicon hosts. Intel hosts require the
architecture changes described in [Changing Architecture](#changing-architecture).

If your host Nix install has not enabled flakes and the new CLI yet, add
`--extra-experimental-features 'nix-command flakes'` to host-side `nix`
commands, for example:
`nix --extra-experimental-features 'nix-command flakes' build .#vfkit`.

The easiest path is to run `./rootcell` once and follow the exact commands it
prints. The full one-time setup is:

```bash
chmod +x ./rootcell

# Install Bun if it is not already available.
curl -fsSL https://bun.sh/install | bash

# Confirm the default vfkit host package builds.
nix build .#vfkit

# Store the default Bedrock provider key in Keychain.
security add-generic-password -a "$USER" -s aws-bedrock-api-key -w "<your-key>"

# Start rootcell.
./rootcell
```

First run downloads compatible rootcell VM images from the `rootcell-images`
release manifest, creates instance-local vfkit disks, and provisions the VMs.
Later runs normally take seconds.

### VM Provider Selection

vfkit is the default VM provider:

```bash
./rootcell
```

The Lima provider remains as a rollback path while vfkit support settles:

```bash
ROOTCELL_VM_PROVIDER=lima ./rootcell
```

The legacy Lima path still requires the one-time `socket_vmnet` and
`rootcell-vmnet` sudo setup printed by `./rootcell` when that provider is
selected.

Image resolution is controlled by:

```bash
ROOTCELL_IMAGE_MANIFEST_URL=https://github.com/rootcell-ai/rootcell-images/releases/latest/download/manifest.json
ROOTCELL_IMAGE_DIR=/path/to/local/rootcell-images
```

`ROOTCELL_IMAGE_DIR` must contain `manifest.json` plus the image files named in
that manifest. Image artifacts are built and published from the separate
[`rootcell-images`](https://github.com/rootcell-ai/rootcell-images) repository;
this repository only consumes those release assets at VM creation time.

## Daily Workflow

```bash
./rootcell                        # open a bash shell inside the agent VM
./rootcell pi                     # run pi directly
./rootcell -- nix flake update    # run any command inside the agent VM
./rootcell allow                  # reload network allowlists after editing them
./rootcell provision              # rebuild/re-provision after Nix or pi config edits
./rootcell pubkey                 # print the agent VM's SSH public key
./rootcell spy                    # tail formatted Bedrock Runtime traffic
./rootcell spy --raw              # include sanitized raw JSON bodies too
./rootcell spy --tui              # browse Bedrock Runtime traffic interactively

./rootcell --instance dev         # open the dev instance shell
./rootcell --instance dev allow   # reload only the dev instance allowlists
```

## Allowing Network Access

Network policy is per instance. On first run, `./rootcell` copies each tracked
`proxy/*.defaults` file to `.rootcell/instances/<name>/proxy/`:

- `.rootcell/instances/default/proxy/allowed-dns.txt` controls which hostnames can resolve.
- `.rootcell/instances/default/proxy/allowed-https.txt` controls which HTTPS hosts can be reached.
- `.rootcell/instances/default/proxy/allowed-ssh.txt` controls which SSH hosts can be reached.

For most HTTPS access, add the host to both DNS and HTTPS, then reload:

```bash
$EDITOR .rootcell/instances/default/proxy/allowed-dns.txt
$EDITOR .rootcell/instances/default/proxy/allowed-https.txt
./rootcell allow
```

For Git over SSH, add the host to the instance's `allowed-ssh.txt` and run
`./rootcell allow`. GitHub, GitLab, Bitbucket, and Azure DevOps are included in the
default SSH allowlist.

Reloading allowlists takes about a second and does not rebuild either VM. To
reset a live allowlist to project defaults, delete the live file and run
`./rootcell`; it will be re-seeded from its `.defaults` sibling. For a named
instance, use the same paths under `.rootcell/instances/<name>/proxy/` and run
`./rootcell --instance <name> allow`.

## Common Changes

After editing these files, run `./rootcell provision`:

- `flake.nix`, `common.nix`, `agent-vm.nix`, `firewall-vm.nix`, or `home.nix`
- Anything under `pi/`
- The checked-in allowlist defaults

For live allowlist edits only, use `./rootcell allow`.

### Add Tools

Edit `home.packages` in `home.nix`, then run:

```bash
./rootcell provision
```

### Customize Pi

The agent VM is preconfigured to run [Pi](https://pi.dev). Support for other
coding harnesses is on the roadmap.

Everything under `pi/agent/` on the host is symlinked into `~/.pi/agent/` inside
the agent VM.

- `pi/agent/AGENTS.md` becomes the global instruction file.
- `pi/agent/skills/<name>/SKILL.md` becomes a global pi skill.

Add or edit files there, then run `./rootcell provision`.

Per-project rules still belong in an `AGENTS.md` or `CLAUDE.md` at the root of
the project you are working on inside the VM.

### Push to GitHub, etc

The agent VM generates its own RSA SSH keypair on first provision. The private
key stays in the VM; the public key is meant to be registered with GitHub,
GitLab, Bitbucket, Azure DevOps, or a deploy key.

```bash
./rootcell pubkey
```

After registering the key, `git push` works from inside the agent VM as long as
the host is on that instance's `allowed-ssh.txt`.

## Security Model

rootcell is designed to reduce accidental and routine agent egress, not to be a
complete data-loss-prevention system.

What it does:

- Keeps the host filesystem out of the VM by avoiding default host mounts.
- Gives the agent VM only a private link to the firewall VM.
- Routes DNS through a suffix allowlist.
- Intercepts HTTPS at the firewall and checks both TLS SNI and HTTP `Host`.
- Validates the upstream certificate before sending bytes onward.
- Denies cleartext HTTP instead of allowlisting unauthenticated `Host` headers.

What remains your responsibility:

- Be careful with broad wildcards such as `*.cloudfront.net` or
  `*.githubusercontent.com`; allowed shared infrastructure can become an exfil
  path.
- Avoid allowlisting DNS-over-HTTPS endpoints unless you really need them.
- Treat any allowed writeable service as a possible outbound channel.
- Remember that network policy cannot prevent timing channels or encoded data in
  legitimate requests.

Known technical gaps and operational debugging notes live in
[proxy/README.md](proxy/README.md).

## Roadmap

rootcell's current goal is to make the narrow macOS + Bedrock + Pi path solid
before broadening the support matrix. Planned expansion includes:

- **Host compatibility:** support both macOS and Linux hosts.
- **LLM providers:** add OpenAI and Anthropic alongside Amazon Bedrock.
- **Coding harnesses:** support Codex CLI and Claude Code CLI alongside Pi.

The long-term shape is a provider- and harness-pluggable local VM boundary, with
the same explicit network policy model across supported hosts.

## Project Layout

```text
rootcell                 host entry point for VM lifecycle and commands
src/                     Bun TypeScript implementation for migrated entrypoints
flake.nix                Nix inputs, guest VM configs, and host packages
common.nix               shared NixOS config for both VMs
agent-vm.nix             agent VM network and trust-store config
firewall-vm.nix          firewall VM services and nftables rules
home.nix                 pi, Git, SSH, and developer tools for the agent VM
nixos.yaml               Lima config for the agent VM
firewall.yaml            Lima config for the firewall VM
network.nix              default inter-VM network settings
.env.defaults            seed values for per-instance `.env`
secrets.env.defaults     seed Keychain secret mappings for per-instance `secrets.env`
.rootcell/               gitignored per-instance state, allowlists, CA, and generated files
proxy/                   allowlists and mitmproxy/dnsmasq firewall code
  agent_spy.py           Bedrock Runtime formatter for `./rootcell spy`
  agent_spy_tui.py       Textual browser for `./rootcell spy --tui`
pi/agent/                global pi instructions, skills, and extensions
completions/             bash and zsh completion for `rootcell`
pkgs/socket_vmnet.nix    local package for Lima's vmnet helper
```

## VM Lifecycle

vfkit instance state lives under `.rootcell/instances/<name>/vfkit/`. The host
control key and generated SSH config live under `.rootcell/instances/<name>/ssh/`.
The agent VM is reached through SSH ProxyJump via the firewall VM; no VSOCK
device is attached on the vfkit path.

### Lima Rollback

The commands below apply to the legacy Lima provider when run with
`ROOTCELL_VM_PROVIDER=lima`.

Stop the VMs but keep their disks and Nix store caches:

```bash
limactl stop agent
limactl stop firewall
./rootcell

limactl stop agent-dev firewall-dev
./rootcell --instance dev
```

Delete the VMs for a clean slate:

```bash
limactl delete agent firewall --force
./rootcell

limactl delete agent-dev firewall-dev --force
./rootcell --instance dev
```

If you edit `nixos.yaml` or `firewall.yaml`, Lima will not apply those changes
to existing VMs automatically. Either run `limactl edit <name>` or delete and
recreate the VM.

## Configuration

### Environment

`./rootcell` seeds `.rootcell/instances/<name>/.env` from `.env.defaults` on
first run. Edit that file for instance-local settings such as:

```sh
AWS_REGION=us-west-2
ROOTCELL_SUBNET_POOL_START=192.168.100.0
ROOTCELL_SUBNET_POOL_END=192.168.254.0
```

The first run also writes `.rootcell/instances/<name>/state.json` with the
instance's vmnet UUID and allocated `/24`. By default, rootcell chooses the first
free subnet from `192.168.100.0/24` through `192.168.254.0/24`, uses `.2` for
the firewall, and uses `.3` for the agent. Existing state is not recalculated if
you later edit the pool values.

To pin a new instance to a specific subnet before first run, set both IPs in
that instance's `.env`:

```sh
FIREWALL_IP=192.168.109.2
AGENT_IP=192.168.109.3
NETWORK_PREFIX=24
```

`./rootcell` also seeds `.rootcell/instances/<name>/secrets.env` from
`secrets.env.defaults` on first run. This file maps agent VM environment
variable names to macOS Keychain service names; it does not contain the secret
values themselves:

```sh
AWS_BEARER_TOKEN_BEDROCK=aws-bedrock-api-key
```

For example, to inject an additional `ANTHROPIC_API_KEY`:

```sh
security add-generic-password -a "$USER" -s anthropic-api-key -w "<your-key>"
echo 'ANTHROPIC_API_KEY=anthropic-api-key' >> .rootcell/instances/default/secrets.env
```

If you want to use Anthropic or OpenAI subscriptions, you can log in from
inside the VM.

Do not put provider keys in `home.nix`; the Nix store is world-readable.

### Shell Completions

`rootcell completion` prints the yargs-generated completion script. The checked-in
files under `completions/` are generated from that command; refresh them with
`bun run completions` after changing commands or options. The generated scripts
register `rootcell`, so put `rootcell` on `PATH` before sourcing or installing
them.

For zsh, after `compinit`:

```sh
rootcell completion >> ~/.zshrc
```

For bash:

```sh
rootcell completion >> ~/.bashrc
```

### Changing Architecture

The default configuration is for Apple Silicon hosts with `aarch64-linux`
guests. For Intel Macs or x86 Linux guests, update these together:

- `system` in `flake.nix`
- The pi release tarball URL and hash in `home.nix`
- The pinned rootcell source and image artifacts in `rootcell-images`

### Multiple Instances

Named instances are isolated from each other:

```bash
./rootcell --instance dev
./rootcell --instance review
```

Each instance gets its own VMs, state directory, CA, allowlists, Keychain mapping
file, control SSH key, private-link sockets, and `/24`.

The `default` instance migrates from legacy repo-local files on first run: if
`.env`, `secrets.env`, `proxy/allowed-*.txt`, or `pki/` already exist, rootcell
copies them into `.rootcell/instances/default/`. Named instances seed from the
checked-in defaults.

Existing VMs created by the legacy Lima provider are not migrated in place. Use
the Lima rollback provider to delete them if needed:

```bash
limactl delete agent firewall --force
./rootcell
```

## Troubleshooting

See what the firewall is denying:

```bash
./rootcell --instance default spy
```

See formatted Bedrock Runtime requests and responses:

```bash
./rootcell spy
./rootcell spy --raw
./rootcell spy --tui
```

Check that firewall services are listening:

```bash
ssh -F .rootcell/instances/default/ssh/config rootcell-firewall -- \
  "ss -tln '( sport = :8080 or sport = :8081 )' && ss -uln '( sport = :53 )'"
```

Test an HTTPS allowlist entry from inside the VM:

```bash
./rootcell -- curl -v https://example.com
```

Inspect the live allowlists inside the firewall VM:

```bash
ssh -F .rootcell/instances/default/ssh/config rootcell-firewall -- \
  "cat /etc/agent-vm/allowed-https.txt && cat /etc/agent-vm/dnsmasq-allowlist.conf"
```

## License

Copyright (C) 2026 Jim Pudar.

rootcell is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE).
