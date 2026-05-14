{
  description = "rootcell: root-capable coding-agent workspaces with allowlisted egress";

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
      #   - GUEST_USER in ./rootcell
      #   - --set '.user.name = "<this>"' passed to limactl start
      username = "luser";

      pkgs = nixpkgs.legacyPackages.${system};

      mkVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        # nixos-lima is referenced from common.nix; username from both.
        specialArgs = { inherit username nixos-lima; };
        modules = [ module ];
      };

      mkVfkitVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username nixos-lima; };
        modules = [
          module
          ({ ... }: { rootcell.limaGuestSupport = false; })
        ];
      };

      # Host-side packages. vfkit is the default macOS VM runtime; the
      # patched Lima and socket_vmnet outputs remain as rollback support.
      forEachDarwin = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" ];
      darwinPkgs = forEachDarwin (sys:
        let p = nixpkgs.legacyPackages.${sys};
        in {
          lima = p.lima.overrideAttrs (old: rec {
            version = "2.1.1";
            src = p.fetchFromGitHub {
              owner = "lima-vm";
              repo = "lima";
              rev = "v${version}";
              hash = "sha256-U054xA3utBcSfpyvsZi4MvgJGNa7QyAYJf9usNXpgXg=";
            };
            vendorHash = "sha256-C4YCuFVXkL5vS6lWZCGkEeZQgAkP55buPDGZ/wvMnAA=";
            patches = (old.patches or []) ++ [
              ./patches/lima-vz-vsock-no-default-usernet.patch
            ];
            meta = old.meta // {
              knownVulnerabilities = [];
            };
          });
          vfkit = p.vfkit;
          socket_vmnet = p.callPackage ./pkgs/socket_vmnet.nix { };
        });
    in
    {
      # Two VMs share common.nix; each pulls in its own role module.
      # Built/switched with `nixos-rebuild switch --flake .#<name>`.
      nixosConfigurations = {
        agent-vm    = mkVM ./agent-vm.nix;
        firewall-vm = mkVM ./firewall-vm.nix;
        agent-vm-vfkit    = mkVfkitVM ./agent-vm.nix;
        firewall-vm-vfkit = mkVfkitVM ./firewall-vm.nix;
      };

      # Home Manager only attaches to the agent VM. The firewall VM is an
      # appliance with no interactive user. Built/switched with `home-manager`.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };

      packages = forEachDarwin (sys: {
        lima         = darwinPkgs.${sys}.lima;
        vfkit        = darwinPkgs.${sys}.vfkit;
        socket_vmnet = darwinPkgs.${sys}.socket_vmnet;
        default      = darwinPkgs.${sys}.vfkit;
      });
    };
}
