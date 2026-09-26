#!/usr/bin/env bash
# The Operator for the WebKit check: its camera clip (two men taking turns to talk, with their sound; NASA, US government
# Preview build r7f.
# work), and the preview's own files as deployed, so every row serves the page itself. Proxied, the Mac runner's fetches
# of the 10 MB model runtime timed out and the Simulator never found a face.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; fixtures="$1"; dist="$(dirname "$fixtures")/dist"
cp "$here/two-speakers-turns.mp4" "$fixtures/"
mkdir -p "$dist"; cp "$here/_headers" "$dist/_headers"; n=0  # Pages reads _headers itself and does not serve it
while read -r p; do [ -n "$p" ] || continue; curl -fsSL --retry 3 --create-dirs -o "$dist/$p" "https://operator.missions-9p6.pages.dev/$p"; n=$((n + 1)); done < "$here/files.txt"
grep -q "app.js?v=" "$dist/index.html" || { echo "index.html did not come back as the page"; exit 1; }
echo "the preview's $n files in $dist"
