---
name: add-flake-dep
description: Add a new dependency (system tool, language library, or CLI) to a project's local flake.nix and reload the dev shell. Use this any time the user asks to install, add, or pull in a tool or library that isn't already on PATH or importable, instead of reaching for pip, npm install -g, apt, brew, cargo install, or ad-hoc downloads.
---

# Add a dependency to flake.nix

Every project in this VM declares its toolchain in a local `flake.nix`,
loaded automatically on `cd` via `nix-direnv`. Adding a dependency means
editing that flake — not running an imperative installer.

## Steps

1. **Locate the project's `flake.nix`** at the repo root. If there isn't
   one, stop and ask the user — they may want to scope the project's
   toolchain deliberately rather than auto-creating a flake.

2. **Pick the right Nix attribute** for what you need:
   - System tool (e.g. `jq`, `ripgrep`, `ffmpeg`): `pkgs.<name>`
   - Python library: `pkgs.python<version>Packages.<name>`
     (e.g. `python312Packages.requests`)
   - Node CLI: prefer adding it as a project `devDependency` in
     `package.json` and invoking via `npx`. Only fall back to a Nix
     install if it's a system-level tool.
   - Search [search.nixos.org/packages](https://search.nixos.org/packages)
     when unsure.

3. **Edit `flake.nix`.** Typical shape:

   ```nix
   devShells.${system}.default = pkgs.mkShell {
     packages = with pkgs; [
       jq
       ripgrep
       (python312.withPackages (ps: with ps; [ requests numpy ]))
     ];
   };
   ```

   For Python projects, add libs inside the `python<ver>.withPackages`
   list. For everything else, add to the top-level `packages` list.

4. **Reload the dev shell:**

   ```bash
   direnv reload
   ```

   Or exit the dir and `cd` back in.

5. **Verify** with `which <tool>` or by importing the library.

## When the package isn't in nixpkgs

For Python: use [`pyproject.nix`](https://pyproject-nix.github.io/pyproject.nix/)
to translate the project's `pyproject.toml` into a Nix derivation. The
flake then declares the env from the manifest.

For other ecosystems where the Nix path is genuinely blocked: stop and
ask the user before falling back to imperative installs. A single ad-hoc
`pip install` or `cargo install` breaks reproducibility.

## What never to do

- `pip install <pkg>`, `pipx install <pkg>`
- `npm install -g <pkg>`, `pnpm add -g <pkg>`, `yarn global add <pkg>`
- `apt install`, `dpkg -i`
- `brew install`
- `cargo install`, `go install`
- `curl … | sh` for installer scripts
- Editing `home.nix` to add a project-specific dep — `home.nix` is for
  VM-wide tooling; project deps live in the project's flake.
