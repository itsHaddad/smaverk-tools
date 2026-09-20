#!/usr/bin/env bash
# build.sh: the one way to build dist/. Builds the script and stamps it with a version, because Cloudflare's edge
# caches app.js for 4 h regardless of our headers. deploy.sh and the gates workflow both call it, so the gates test what ships.
set -euo pipefail
cd "$(dirname "$0")"
V=${1:-$(date +%s)}
rm -f dist/*.js
bun build app.ts --target browser --outdir dist --minify --splitting --format esm | tail -3
sed -i "s|src=\"app.js[^\"]*\"|src=\"app.js?v=$V\"|" dist/index.html
grep -q "app.js?v=$V" dist/index.html || { echo "version stamp failed"; exit 1; }
# media references get the same stamp, so a replaced sample or poster is never served stale from the edge or a browser cache
sed -i -E "s#(sample\\.mp4|poster\\.(jpg|webp)|sample-words\\.json|vertical-track\\.json)(\\?v=[0-9]+)?([\"')])#\\1?v=$V\\4#g" dist/index.html
# whether the sample has a sound track decides if the sound button shows at rest
if ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 dist/sample.mp4 | grep -q audio; then SND=1; else SND=0; fi
sed -i -E "s#(<div class=\"stage\" id=\"stage\")( data-sample-sound=\"[01]\")?#\\1 data-sample-sound=\"$SND\"#" dist/index.html
# The search pages are made from dist/index.html AFTER every stamp above, so each one carries the same app.js and media
# versions as the home page and no sed has to know their names. tests/pages.test.ts fails if a page is stale.
bun tools/pages.ts
echo "built v=$V"
