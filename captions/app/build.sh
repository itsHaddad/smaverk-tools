#!/usr/bin/env bash
# build.sh: the one way to build dist/. Builds the scripts and stamps them with a version, because Cloudflare's edge
# caches app.js for 4 h regardless of our headers. deploy.sh and the gates workflow both call it, so the gates test what ships.
set -euo pipefail
cd "$(dirname "$0")"
V=${1:-$(date +%s)}
rm -f dist/*.js
bun tools/mark-lines.ts | cut -c1-160   # the studio card breaks its caption lines where the tool does
# The studio cards run the other tools' own sample data, copied here at build time so a replaced sample updates
# every page that shows it. dist/studio-demo/ is GITIGNORED and exists only because this line makes it — and a
# Pages deploy uploads dist/ as a whole snapshot, so a build that writes one tool's files and not another's
# DELETES the missing one from the live page. Every card's data is produced here, together, or not at all.
mkdir -p dist/studio-demo
cp ../../vertical/app/dist/sample.mp4 dist/studio-demo/vertical-sample.mp4
cp ../../vertical/app/dist/sample-track.json dist/studio-demo/vertical-track.json
cp ../../vertical/app/dist/poster.jpg dist/studio-demo/vertical-poster.jpg
cp ../../clipfinder/app/dist/sample.json dist/studio-demo/clipfinder-sample.json
for f in vertical-sample.mp4 vertical-track.json vertical-poster.jpg clipfinder-sample.json; do
  [ -s "dist/studio-demo/$f" ] || { echo "studio-demo/$f is missing or empty; deploying now would take it off the live page"; exit 1; }
done
bun build app.ts worker.ts --target browser --outdir dist --minify --splitting --format esm | tail -3
sed -i "s|src=\"app.js[^\"]*\"|src=\"app.js?v=$V\"|" dist/index.html
sed -i "s|new URL(\"./worker.js[^\"]*\", *location.href)|new URL(\"./worker.js?v=$V\", location.href)|" dist/app.js
grep -q "app.js?v=$V" dist/index.html && grep -q "worker.js?v=$V" dist/app.js || { echo "version stamp failed"; exit 1; }
# media references get the same stamp, so a replaced sample or poster is never served stale from the edge or a browser cache
sed -i -E "s#(sample\\.mp4|poster\\.(jpg|webp)|sample-words\\.json|vertical-track\\.json|clipfinder-sample\\.json)(\\?v=[0-9]+)?([\"')])#\\1?v=$V\\4#g" dist/index.html dist/studio.html
# the studio's Vertical card shows a sound button only when Vertical's sample has a sound track
if ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 dist/studio-demo/vertical-sample.mp4 | grep -q audio; then sed -i -E "s#(<button class=\"sound\" data-for=\"vertical-sound\" type=\"button\") hidden#\\1#" dist/studio.html; else sed -i -E "s#(<button class=\"sound\" data-for=\"vertical-sound\" type=\"button\")( hidden)?#\\1 hidden#" dist/studio.html; fi
# The search pages are made from dist/index.html AFTER every stamp above, so each one carries the same app.js and media
# versions as the home page and no sed has to know their names. tests/pages.test.ts fails if a page is stale.
bun tools/pages.ts
echo "built v=$V"
