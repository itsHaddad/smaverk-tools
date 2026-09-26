#!/usr/bin/env bash
# build.sh: the one way to build dist/. Clips is built out of the other three tools' own code, so their packages must be
# installed first; the scripts are stamped with a version because Cloudflare's edge caches them for hours.
set -euo pipefail
cd "$(dirname "$0")"
V=${1:-$(date +%s)}
for d in captions vertical clipfinder; do [ -d "../../$d/app/node_modules" ] || (cd "../../$d/app" && bun install --frozen-lockfile >/dev/null); done
rm -f dist/*.js
bun build app.ts finder.ts listen.ts --target browser --outdir dist --minify --splitting --format esm | tail -4
# The speaker search is Vertical's, and so are its files: copied from Vertical's dist so both tools ship the same bytes.
# dist/mediapipe and dist/models are gitignored here and exist only because this line makes them.
mkdir -p dist/mediapipe dist/models
cp ../../vertical/app/dist/mediapipe/* dist/mediapipe/
cp ../../vertical/app/dist/models/blaze_face_short_range.tflite dist/models/
sed -i -E "s|src=\"app\.js[^\"]*\"|src=\"app.js?v=$V\"|" dist/index.html
sed -i -E "s#new URL\(\"\./(finder|listen)\.js[^\"]*\", *location\.href\)#new URL(\"./\1.js?v=$V\", location.href)#g" dist/app.js
grep -q "app.js?v=$V" dist/index.html || { echo "version stamp failed: index.html"; exit 1; }
grep -q "finder.js?v=$V" dist/app.js && grep -q "listen.js?v=$V" dist/app.js || { echo "version stamp failed: worker urls in app.js"; exit 1; }
# the sample, its clips and poster are fetched under the page's version (app.js?v=…), and the poster in the page gets the stamp here
sed -i -E "s#(poster\.jpg|sample-strip\.mp4)(\?v=[0-9]+)?([\"')])#\1?v=$V\3#g" dist/index.html
echo "built v=$V"
