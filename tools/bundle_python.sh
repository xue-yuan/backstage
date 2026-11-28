#!/bin/sh
# Copy a Python runtime into src-tauri/python for the Mac app to bundle (Contents/Resources/python),
# so users do not need to install Python themselves. `pnpm app:build` and `pnpm app:dev` run it first.
#
# The runtime is the uv-managed interpreter (python-build-standalone, which can be moved anywhere)
# for this Mac's architecture. Parts the server never uses (pip, Tk, IDLE, headers…) are left out.
set -eu
cd "$(dirname "$0")/.."

python=$(uv python find --no-project --managed-python ">=3.12")
root=$(cd "$(dirname "$(realpath "$python")")/.." && pwd -P)
version=$("$python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
dest=src-tauri/python

rm -rf "$dest"
mkdir -p "$dest/bin"
rsync -a \
  --exclude "/bin/" \
  --exclude "/include/" \
  --exclude "/share/" \
  --exclude "/lib/pkgconfig/" \
  --exclude "/lib/tcl*" --exclude "/lib/tk*" --exclude "/lib/itcl*" --exclude "/lib/thread*" \
  --exclude "/lib/libtcl*" --exclude "/lib/libtk*" --exclude "/lib/libpython*" \
  --exclude "/lib/python$version/site-packages/*" \
  --exclude "/lib/python$version/config-*" \
  --exclude "/lib/python$version/idlelib/" \
  --exclude "/lib/python$version/tkinter/" \
  --exclude "/lib/python$version/turtledemo/" \
  --exclude "/lib/python$version/ensurepip/" \
  --exclude "/lib/python$version/test/" \
  --exclude "/lib/python$version/lib-dynload/_tkinter*" \
  "$root/" "$dest/"
cp "$root/bin/python$version" "$dest/bin/python3" # one real file: links would be copied twice into the app

# The server must run on it (standard library only).
"$dest/bin/python3" -E -s -B -c 'import json, sqlite3, http.server, subprocess, wave, unicodedata' >/dev/null
echo "Bundled Python $version ($(du -sh "$dest" | cut -f1)) from $root"
