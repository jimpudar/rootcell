{ ... }:

{
  imports = [ ../common.nix ];

  networking.hostName = "rootcell-builder";
  networking.useDHCP = true;
  networking.useNetworkd = true;
  systemd.network.enable = true;
  systemd.network.networks."10-enp0s1" = {
    matchConfig.Name = "enp0s1";
    networkConfig.DHCP = "ipv4";
  };
}
