{ modulesPath, pkgs, lib, username, ... }:

# Shared NixOS bits used by both the agent VM and the firewall VM. Things
# that are genuinely VM-specific (hostname, networking, firewall policy,
# services) live in agent-vm.nix and firewall-vm.nix respectively.

{
  imports = [
    # Required for the guest to boot under virtio VM runtimes.
    (modulesPath + "/profiles/qemu-guest.nix")
  ];

  config = {
    # Rootcell manages guests over SSH through the firewall.
    services.openssh.enable = true;

    users.users.${username} = {
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      shell = pkgs.bash;
      linger = true;
    };

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

    boot.loader.grub = {
      device = lib.mkDefault "nodev";
      efiSupport = lib.mkDefault true;
      efiInstallAsRemovable = lib.mkDefault true;
    };

    fileSystems."/boot" = {
      device = lib.mkDefault "/dev/vda1";
      fsType = lib.mkDefault "vfat";
    };

    fileSystems."/" = {
      device = lib.mkDefault "/dev/disk/by-label/nixos";
      autoResize = lib.mkDefault true;
      fsType = lib.mkDefault "ext4";
      options = [ "noatime" "nodiratime" "discard" ];
    };

    environment.enableAllTerminfo = true;
    boot.kernelPackages = pkgs.linuxPackages_latest;

    system.stateVersion = "25.11";
  };
}
