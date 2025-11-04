{
  description = "ROF detector with ffmpeg.wasm";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        packageJson = builtins.fromJSON (builtins.readFile ./package.json);
        nodeModules = pkgs.importNpmLock.buildNodeModules {
          npmRoot = self;
          inherit (pkgs) nodejs;
        };
        buildPackage = pkgs.stdenv.mkDerivation {
          pname = "rof-gui";
          version = packageJson.version;

          src = self;

          nativeBuildInputs = with pkgs; [
            nodejs
            nodePackages.npm
          ];

          buildPhase = ''
            ln -s ${nodeModules}/node_modules node_modules
            npm run build
          '';

          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
          '';
        };
      in
      {
        packages = {
          default = buildPackage;
          nix-direnv = pkgs.nix-direnv;
        };
        devShells.default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            act
            importNpmLock.hooks.linkNodeModulesHook
            nodejs
          ];
          npmDeps = nodeModules;
        };
      }
    );
}
