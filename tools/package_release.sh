#!/bin/sh
# Build Cratify.app and package it for a GitHub release:
#   dist/Cratify-<version>-mac-<arch>.zip   the app (ditto keeps the code signature and attributes)
#   dist/release-notes.md                   this version's section of CHANGELOG.md
# It prints the `gh release create` command to publish them; it publishes nothing itself.
#
#   pnpm app:release
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
cargo_version=$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -n 1)
if [ "$version" != "$cargo_version" ]; then
  echo "package.json is $version but src-tauri/Cargo.toml is $cargo_version: set both to the same version." >&2
  exit 1
fi

mkdir -p dist
notes=dist/release-notes.md
# The lines from "## <version>" up to the next "## " heading.
awk -v head="## $version" '/^## / { on = (index($0, head) == 1) } on' CHANGELOG.md > "$notes"
if [ ! -s "$notes" ]; then
  echo "CHANGELOG.md has no \"## $version\" section: write the release notes first." >&2
  exit 1
fi

pnpm app:build

app=src-tauri/target/release/bundle/macos/Cratify.app
zip="dist/Cratify-$version-mac-$(uname -m).zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

echo
shasum -a 256 "$zip"
echo
echo "To publish:"
echo "  gh release create v$version \"$zip\" --title \"Cratify $version\" --notes-file $notes"
