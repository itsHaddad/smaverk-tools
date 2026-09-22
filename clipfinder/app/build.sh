#!/usr/bin/env bash
# build.sh: the one way to build dist/. Builds the scripts and stamps them with a version, because
# Cloudflare's edge caches app.js for hours regardless of our headers. deploy.sh and the gates workflow
# both call it, so the gates test what ships.
set -euo pipefail
cd "$(dirname "$0")"
V=${1:-$(date +%s)}
rm -f dist/*.js
bun build app.ts worker.ts --target browser --outdir dist --minify --splitting --format esm | tail -3
sed -i -E "s|src=\"app\.js[^\"]*\"|src=\"app.js?v=$V\"|" dist/index.html
sed -i -E "s|new URL\(\"\./worker\.js[^\"]*\", *location\.href\)|new URL(\"./worker.js?v=$V\", location.href)|" dist/app.js
grep -q "app.js?v=$V" dist/index.html || { echo "version stamp failed: index.html"; exit 1; }
grep -q "worker.js?v=$V" dist/app.js || { echo "version stamp failed: worker url in app.js"; exit 1; }
# The sample is a real recording we read with this tool; a replaced sample must not be served stale. The
# address of the sound lives INSIDE sample.json, so it is stamped there rather than in the script.
sed -i -E "s#(sample\.json|poster\.png)(\?v=[0-9]+)?([\"')])#\1?v=$V\3#g" dist/index.html dist/app.js
# The sample is a video now (sample.mp4 + poster.jpg); sample.m4a is what a sound-only sample would be.
sed -i -E "s#\"(audio|poster)\": ?\"(sample\.m4a|sample\.mp4|poster\.jpg)(\?v=[0-9]+)?\"#\"\1\": \"\2?v=$V\"#g" dist/sample.json
grep -qE "sample\.(m4a|mp4)\?v=$V" dist/sample.json || { echo "version stamp failed: the sample"; exit 1; }
if grep -q '"video": true' dist/sample.json; then grep -q "poster.jpg?v=$V" dist/sample.json || { echo "version stamp failed: the sample poster"; exit 1; }; fi
echo "built v=$V"
