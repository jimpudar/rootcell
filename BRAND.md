# rootcell brand

## Name

rootcell

rootcell explains the promise: the agent gets root, but only inside a contained
cell with an explicit network boundary.

This is a working user-facing name, not legal trademark clearance. Re-check the
name before publishing packages, reserving domains, or launching a public site.

## Tagline

Give the agent root in the cell, not on your host.

## One-Liner

rootcell runs a coding agent with root inside a local NixOS VM and routes all
outbound network access through a separate allowlist firewall VM.

## Positioning

rootcell is for developers who want agentic coding to feel useful and practical
without handing an agent their host filesystem and unrestricted internet access.

It should sound:

- Capable, not paranoid.
- Clear, not compliance-heavy.
- Local-first and developer-friendly.
- Honest about the security boundary.

## Core Messages

- Let the agent use a real shell without giving it your Mac.
- Make network access visible, reviewable, and reloadable.
- Keep the setup reproducible with Nix and local VMs.
- Treat the firewall as a practical boundary, not a magic sandbox.

## Vocabulary

Prefer:

- agent VM
- firewall VM
- allowlist
- disposable workspace
- local VM
- network boundary
- provider key

Avoid leading with:

- TLS MITM
- socket_vmnet
- NixOS module internals
- Lima named-network details
- provider-specific setup

Those details matter, but they belong after the reader understands what the
project does for them.

## Short Description

rootcell creates a disposable local Linux workspace for a coding agent and places
a small firewall VM between that workspace and the internet. The agent can run
commands, use Git, and work normally, while DNS, HTTPS, and SSH egress stay
behind editable allowlists.
