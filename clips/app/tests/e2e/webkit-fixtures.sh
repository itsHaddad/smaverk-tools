#!/usr/bin/env bash
# webkit-fixtures.sh <dir>: the recording the WebKit check picks. The product gate's own five-minute fixture (fixture.mjs:
# a 1080p face and a real talk), so the engine check and the gate judge the same input.
set -euo pipefail
dir=${1:?usage: webkit-fixtures.sh <dir>}; mkdir -p "$dir"
root=$(cd "$(dirname "$0")/../.." && pwd)
src=$(cd "$root" && bun -e 'const { makeFixture } = await import("./tests/e2e/fixture.mjs"); console.log(makeFixture(process.cwd()))')
cp "$src" "$dir/talk-5min-1080p.mp4"
ffprobe -v error -show_entries stream=codec_type,width,height:format=duration,size -of compact=p=0 "$dir/talk-5min-1080p.mp4"
