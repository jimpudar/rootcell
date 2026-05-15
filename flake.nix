{
  description = "rootcell: root-capable coding-agent workspaces with allowlisted egress";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, home-manager, ... }:
    let
      # Apple Silicon hosts use aarch64-linux guests.
      # Switch to "x86_64-linux" if you're on an Intel Mac or x86 Linux host.
      system = "aarch64-linux";

      # Username inside the guest. MUST agree with:
      #   - GUEST_USER in ./rootcell
      username = "luser";

      pkgs = nixpkgs.legacyPackages.${system};

      mkVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username; };
        modules = [ module ];
      };

      mkImage = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username; };
        modules = [ module ./images/vfkit-image.nix ];
      };

      agentImage = (mkImage ./agent-vm.nix).config.system.build.image;
      firewallImage = (mkImage ./firewall-vm.nix).config.system.build.image;
      builderImage = (mkImage ./images/builder-vm.nix).config.system.build.image;
      rootcellSourceRevision = self.rev or self.dirtyRev or "unknown";
      nixpkgsRevision = nixpkgs.rev or "unknown";

      rootcellImages = pkgs.runCommand "rootcell-image-assets" { nativeBuildInputs = [ pkgs.coreutils pkgs.zstd ]; } ''
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
          "rootcellSourceRevision": "${rootcellSourceRevision}",
          "nixpkgsRevision": "${nixpkgsRevision}",
          "rootcellCliContract": { "min": 1, "max": 1 },
          "images": [
            { "role": "agent", "architecture": "aarch64-linux", "fileName": "agent.raw.zst", "url": "agent.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/agent.raw.zst"), "rawSize": $agent_raw_size, "sha256": "$agent_sha" },
            { "role": "firewall", "architecture": "aarch64-linux", "fileName": "firewall.raw.zst", "url": "firewall.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/firewall.raw.zst"), "rawSize": $firewall_raw_size, "sha256": "$firewall_sha" },
            { "role": "builder", "architecture": "aarch64-linux", "fileName": "builder.raw.zst", "url": "builder.raw.zst", "compression": "zstd", "compressedSize": $(stat -c%s "$out/builder.raw.zst"), "rawSize": $builder_raw_size, "sha256": "$builder_sha" }
          ]
        }
JSON
      '';

      # Host-side packages. vfkit is the macOS VM runtime.
      forEachDarwin = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" ];
      darwinPkgs = forEachDarwin (sys:
        let p = nixpkgs.legacyPackages.${sys};
        in {
          vfkit = p.vfkit;
          zstd = p.zstd;
        });
    in
    {
      # Two VMs share common.nix; each pulls in its own role module.
      # Built/switched with `nixos-rebuild switch --flake .#<name>`.
      nixosConfigurations = {
        agent-vm    = mkVM ./agent-vm.nix;
        firewall-vm = mkVM ./firewall-vm.nix;
        agent-vm-vfkit-image    = mkImage ./agent-vm.nix;
        firewall-vm-vfkit-image = mkImage ./firewall-vm.nix;
        builder-vm-vfkit-image  = mkImage ./images/builder-vm.nix;
      };

      # Home Manager only attaches to the agent VM. The firewall VM is an
      # appliance with no interactive user. Built/switched with `home-manager`.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };

      inherit rootcellSourceRevision nixpkgsRevision;

      packages = forEachDarwin (sys: {
        vfkit   = darwinPkgs.${sys}.vfkit;
        zstd    = darwinPkgs.${sys}.zstd;
        default = darwinPkgs.${sys}.vfkit;
      }) // {
        aarch64-linux = {
          inherit agentImage firewallImage builderImage rootcellImages;
          default = rootcellImages;
        };
      };
    };
}
