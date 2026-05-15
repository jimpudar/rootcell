# rootcell images

Published rootcell NixOS VM images are built from this directory and exposed by
the repository root flake. Image binaries are not committed to git; they are
published only as GitHub Release assets.

This directory was imported from `rootcell-ai/rootcell-images` at `eca892a`.
The old repository remains available while the release stream is migrated.

Each usable image release must include:

- `manifest.json`
- `agent.raw.zst`
- `firewall.raw.zst`
- `builder.raw.zst`

The root flake owns the image outputs:

```bash
nix build .#packages.aarch64-linux.agentImage
nix build .#packages.aarch64-linux.firewallImage
nix build .#packages.aarch64-linux.builderImage
nix build .#packages.aarch64-linux.rootcellImages
```

`rootcellImages` produces the compressed release assets and a manifest matching
the CLI contract in `src/rootcell/images.ts`.

The image release workflow is manual-only so normal pushes, README edits, and
product-only changes do not publish VM images. To build a release locally from
the repository root:

```bash
images/scripts/build-release.sh
images/scripts/validate-dist.sh dist
```

Official image releases are created from explicit tags named
`image-vYYYYMMDD.N`, for example `image-v20260515.1`. Create and push the tag
first, then run the `Release rootcell images` workflow with that exact tag. The
workflow checks out the tag, verifies that it exists, and passes `--verify-tag`
to `gh release create` so GitHub CLI cannot create an implicit tag from the
default branch.

The workflow targets runners labeled `linux`, `arm64`, and `kvm`. The runner
must expose `/dev/kvm` for the NixOS disk-image build.
