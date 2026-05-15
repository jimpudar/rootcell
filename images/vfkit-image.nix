{ config, modulesPath, pkgs, lib, username, ... }:

{
  imports = [
    (modulesPath + "/virtualisation/disk-image.nix")
  ];

  image = {
    format = "raw";
    efiSupport = true;
  };

  services.cloud-init = {
    enable = true;
    network.enable = false;
  };

  services.openssh.settings = {
    PasswordAuthentication = false;
    KbdInteractiveAuthentication = false;
    PermitRootLogin = "no";
  };

  users.users.${username}.openssh.authorizedKeys.keys = lib.mkDefault [];

  environment.systemPackages = with pkgs; [
    cloud-init
    openssh
  ];
}
