# Agent guidelines

This VM is a NixOS machine with a fully declarative toolchain. The global env
(`home.nix`) provides only core CLIs; per-project tooling lives in a project
`flake.nix` loaded automatically by `direnv` when you `cd` into the dir.

## Installing software — the rule

**Never** run any of:

- `pip install`, `pipx install`
- `npm install -g`, `pnpm add -g`, `yarn global add`
- `apt install`, `apt-get install`, `dpkg -i`
- `brew install`
- `cargo install`, `go install`
- `curl … | sh`, manual downloads of binaries to `~/bin` or `/usr/local`

**Always** install software by adding it to the project's `flake.nix` and
reloading the dev shell with `direnv reload`.

If the project doesn't yet have a `flake.nix` / `.envrc`, stop and ask the user
before creating one — they may want to scope it deliberately.

## Python dependencies

1. Look up the package under `pkgs.python<version>Packages.<name>` (e.g.
   `python312Packages.requests`). Most popular libs are there — check first.
2. Add it to the `python<version>.withPackages (ps: with ps; [ … ])` list in
   `flake.nix`.
3. Run `direnv reload` and verify the import works.

If the package is not in nixpkgs:

- Use `pyproject.nix` (the modern successor to `poetry2nix`) to translate the
  project's `pyproject.toml` / `requirements.txt` into Nix derivations.
- Do **not** fall back to `pip install` or to creating a manual venv. If
  `pyproject.nix` can't handle a particular package, surface the problem.

## Node.js dependencies

Project-local deps from `package.json` are fine to install with
`npm install` / `pnpm install` — they live in `node_modules/` and the lockfile
makes them reproducible.

What's **not** allowed: `npm install -g <cli>` to put a tool on `$PATH`. If you
need a global JS CLI:

1. Look for it in nixpkgs (`pkgs.<name>` or `pkgs.nodePackages.<name>`).
2. If not there, add it as a project `devDependency` and invoke via `npx`.

## System packages and CLIs

Anything beyond language deps — system libraries, CLIs, build dependencies —
goes in `flake.nix` too, either in `mkShell`'s `packages` list (tools you'll
invoke) or `buildInputs` (libraries something is linked against).

## When you can't find a Nix-native path

If you genuinely can't figure out how to install something via Nix, **stop and
ask the user**. Do not work around it with an imperative install. The point of
this setup is reproducibility — one ad-hoc `pip install` breaks it.
