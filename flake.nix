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

      mkVfkitImage = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username nixos-lima; };
        modules = [ module ./vfkit-image.nix ];
      };

      mkVfkitVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username nixos-lima; };
        modules = [
          module
          ({ ... }: { rootcell.limaGuestSupport = false; })
        ];
      };

      agentImage = (mkVfkitImage ./agent-vm.nix).config.system.build.image;
      firewallImage = (mkVfkitImage ./firewall-vm.nix).config.system.build.image;
      builderImage = (mkVfkitImage ./builder-vm.nix).config.system.build.image;

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
        agent-vm-vfkit-image    = mkVfkitImage ./agent-vm.nix;
        firewall-vm-vfkit-image = mkVfkitImage ./firewall-vm.nix;
        builder-vm-vfkit-image  = mkVfkitImage ./builder-vm.nix;
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
      }) // {
        aarch64-linux = {
          agentImage = agentImage;
          firewallImage = firewallImage;
          builderImage = builderImage;
          rootcellImages = pkgs.runCommand "rootcell-images" { nativeBuildInputs = [ pkgs.coreutils pkgs.zstd ]; } ''
            mkdir -p "$out"
            cp ${agentImage}/*.img "$out/agent.raw"
            cp ${firewallImage}/*.img "$out/firewall.raw"
            cp ${builderImage}/*.img "$out/builder.raw"
            agent_raw_size="$(stat -c%s "$out/agent.raw")"
            firewall_raw_size="$(stat -c%s "$out/firewall.raw")"
            builder_raw_size="$(stat -c%s "$out/builder.raw")"
            zstd -19 --rm "$out/agent.raw" -o "$out/agent.raw.zst"
            zstd -19 --rm "$out/firewall.raw" -o "$out/firewall.raw.zst"
            zstd -19 --rm "$out/builder.raw" -o "$out/builder.raw.zst"
            agent_sha="$(sha256sum "$out/agent.raw.zst" | cut -d ' ' -f1)"
            firewall_sha="$(sha256sum "$out/firewall.raw.zst" | cut -d ' ' -f1)"
            builder_sha="$(sha256sum "$out/builder.raw.zst" | cut -d ' ' -f1)"
            cat > "$out/manifest.json" <<JSON
            {
              "schemaVersion": 1,
              "guestApiVersion": 1,
              "rootcellSourceRevision": "${self.rev or self.dirtyRev or "dirty"}",
              "nixpkgsRevision": "${nixpkgs.rev or "unknown"}",
              "rootcellCliContract": { "min": 1, "max": 1 },
              "images": [
                { "role": "agent", "architecture": "aarch64-linux", "fileName": "agent.raw.zst", "url": "agent.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/agent.raw.zst"), "rawSize": $agent_raw_size, "sha256": "$agent_sha" },
                { "role": "firewall", "architecture": "aarch64-linux", "fileName": "firewall.raw.zst", "url": "firewall.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/firewall.raw.zst"), "rawSize": $firewall_raw_size, "sha256": "$firewall_sha" },
                { "role": "builder", "architecture": "aarch64-linux", "fileName": "builder.raw.zst", "url": "builder.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/builder.raw.zst"), "rawSize": $builder_raw_size, "sha256": "$builder_sha" }
              ]
            }
JSON
          '';
          default = pkgs.runCommand "rootcell-linux-default" {} "ln -s ${agentImage} $out";
        };
      };
    };
}
