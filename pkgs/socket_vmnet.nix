# socket_vmnet — small daemon that exposes macOS's vmnet.framework over a
# Unix socket so unprivileged tools (Lima, in our case) can use it.
#
# Not in nixpkgs as of writing. We package it ourselves so the binary is a
# Nix-store artifact (root-owned, immutable, byte-for-byte reproducible);
# the only piece outside Nix is the one-time `sudo install` of this binary
# into /opt/socket_vmnet/bin so rootcell's vmnet helper has a stable target.
# The `rootcell` script's preflight builds via this derivation, compares to
# /opt/socket_vmnet, and prints the install command if it's missing or
# stale. See README → "One-time host setup".
#
# Upstream: https://github.com/lima-vm/socket_vmnet

{ stdenv, fetchFromGitHub, lib }:

stdenv.mkDerivation rec {
  pname = "socket_vmnet";
  version = "1.2.2";

  src = fetchFromGitHub {
    owner = "lima-vm";
    repo = "socket_vmnet";
    rev = "v${version}";
    hash = "sha256-D5Z4aml82h397ho48HFeXwR6y2XkopFIKjO09jUgFdo=";
  };

  # The Makefile shells out to `git` to embed the version, which isn't in
  # the sandbox — pass VERSION explicitly to bypass.
  makeFlags = [ "VERSION=${version}" ];

  # The upstream `install.bin` target uses `logger` (BSD syslog) for
  # status output, which also isn't in the sandbox. Side-step it and
  # copy the built binaries directly. We don't ship the launchd plists
  # under share/doc — rootcell invokes socket_vmnet through its own helper
  # at runtime, not as a system launchd daemon.
  installPhase = ''
    runHook preInstall
    install -Dm 0755 -t $out/bin socket_vmnet socket_vmnet_client
    runHook postInstall
  '';

  meta = with lib; {
    description = "Bind macOS vmnet.framework to a Unix socket";
    homepage = "https://github.com/lima-vm/socket_vmnet";
    license = licenses.asl20;
    platforms = platforms.darwin;
    mainProgram = "socket_vmnet";
  };
}
