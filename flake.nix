{
  description = "Interactive Pi agents in Rex tabs";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    nixpkgs-x86_64-darwin.url = "github:nixos/nixpkgs?ref=nixpkgs-26.05-darwin";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      perSystem =
        { system, self', ... }:
        let
          nixpkgs = if system == "x86_64-darwin" then inputs.nixpkgs-x86_64-darwin else inputs.nixpkgs;
          pkgs = import nixpkgs { inherit system; };
        in
        {
          packages = rec {
            default = pi-rexlings;
            pi-rexlings = pkgs.callPackage ./package.nix { };
          };

          checks = {
            package = pkgs.runCommand "pi-rexlings-package-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              package=${self'.packages.default}
              jq -e '.pi.extensions == ["./src/extension.ts"]' "$package/package.json" > /dev/null
              test -f "$package/src/child.ts"
              diff -r ${./src} "$package/src"
              touch "$out"
            '';
          };

          formatter = pkgs.nixfmt;
        };
    };
}
