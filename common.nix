{ config, modulesPath, pkgs, lib, username, nixos-lima, ... }:

# Shared NixOS bits used by both the agent VM and the firewall VM. Things
# that are genuinely VM-specific (hostname, networking, firewall policy,
# services) live in agent-vm.nix and firewall-vm.nix respectively.

{
  imports = [
    # Required for the guest to boot under qemu/vz.
    (modulesPath + "/profiles/qemu-guest.nix")
    # Provides `services.lima.*` options. Sets up lima-init at boot and
    # runs the lima-guestagent daemon as a systemd service.
    nixos-lima.nixosModules.lima
  ];

  # Activate the nixos-lima module. Without this, lima-guestagent won't
  # run and `limactl shell` will fail after rebuild.
  services.lima.enable = true;

  # Lima communicates with the guest over SSH (vsock-multiplexed on vz+Linux,
  # so this works regardless of whether the VM has a routable NIC).
  services.openssh.enable = true;

  # The Lima user. Lima sets up the user at first boot via cloud-init style
  # userdata; we just need the account to exist with sane defaults.
  users.users.${username} = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.bash;
    # nixos-lima's boot-time init waits for the user's systemd manager
    # before it can start lima-guestagent. The agent VM has no NAT SSH
    # fallback after provisioning, so the user manager must come up at boot.
    linger = true;
  };

  # Lima expects passwordless sudo for its guest user.
  security.sudo.wheelNeedsPassword = false;

  # Enable flakes + the new CLI. Required for nixos-rebuild --flake.
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" username ];
    auto-optimise-store = true;
  };

  # Garbage-collect the Nix store weekly so the VM doesn't grow without bound.
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  # Boot/filesystem layout matching the nixos-lima base image.
  # These values come from the nixos-lima image generator and must NOT be
  # changed unless you rebuild the image yourself.
  boot.loader.grub = {
    device = "nodev";
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  fileSystems."/boot" = {
    device = lib.mkForce "/dev/vda1";
    fsType = "vfat";
  };

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    autoResize = true;
    fsType = "ext4";
    options = [ "noatime" "nodiratime" "discard" ];
  };

  environment.enableAllTerminfo = true;
  boot.kernelPackages = pkgs.linuxPackages_latest;

  # Pin to the NixOS release nixos-lima is built against. Don't bump casually.
  system.stateVersion = "25.11";
}
