{
  description = "Disposable NixOS Lima VMs for agentic coding with pi (pi.dev)";

  inputs = {
    # Must match what nixos-lima is built against. v0.0.5 = nixos-25.11.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-lima, home-manager, ... }:
    let
      # Apple Silicon hosts use aarch64-linux guests.
      # Switch to "x86_64-linux" if you're on an Intel Mac or x86 Linux host.
      system = "aarch64-linux";

      # Username inside the guest. MUST agree with:
      #   - GUEST_USER in ./agent
      #   - --set '.user.name = "<this>"' passed to limactl start
      username = "luser";

      pkgs = nixpkgs.legacyPackages.${system};

      mkVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        # nixos-lima is referenced from common.nix; username from both.
        specialArgs = { inherit username nixos-lima; };
        modules = [ module ];
      };

      # Host-side packages — only socket_vmnet today, used by `nix build`
      # in the agent script's preflight. socket_vmnet isn't in nixpkgs,
      # so we package it locally; see pkgs/socket_vmnet.nix and the
      # README for why this needs an explicit one-time `sudo install`.
      forEachDarwin = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" ];
      darwinPkgs = forEachDarwin (sys:
        let p = nixpkgs.legacyPackages.${sys};
        in {
          socket_vmnet = p.callPackage ./pkgs/socket_vmnet.nix { };
        });
    in
    {
      # Two VMs share common.nix; each pulls in its own role module.
      # Built/switched with `nixos-rebuild switch --flake .#<name>`.
      nixosConfigurations = {
        agent-vm    = mkVM ./agent-vm.nix;
        firewall-vm = mkVM ./firewall-vm.nix;
      };

      # Home Manager only attaches to the agent VM. The firewall VM is an
      # appliance with no interactive user. Built/switched with `home-manager`.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };

      packages = forEachDarwin (sys: {
        socket_vmnet = darwinPkgs.${sys}.socket_vmnet;
        default      = darwinPkgs.${sys}.socket_vmnet;
      });
    };
}
