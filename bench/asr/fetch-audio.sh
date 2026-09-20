#!/usr/bin/env bash
# Audio for one or more recordings as 16 kHz mono raw PCM, which is what the transcriber reads.
#
#   bench/asr/fetch-audio.sh 'name=https://example.com/episode.mp3' ...
#
# Plain HTTPS only, on purpose. An earlier version fetched by YouTube id and could not work here at
# all: YouTube refuses datacentre ranges with "Sign in to confirm you're not a bot", so every shard
# failed. The fix is not a cookie — carrying a personal session into a public repository is not a
# thing we will do — it is to fetch the publisher's own file, which is public, stable and served to
# anyone.
set -uo pipefail
DIR=${BENCH_AUDIO:-bench/audio}
mkdir -p "$DIR"
status=0
for spec in "$@"; do
  name=${spec%%=*}
  url=${spec#*=}
  if [ "$name" = "$spec" ] || [ -z "$url" ]; then
    echo "FAILED $spec: expected name=url"; status=1; continue
  fi
  case "$name" in *[!A-Za-z0-9._-]*) echo "FAILED $name: a name becomes a filename, so keep it to letters, digits, dot, dash, underscore"; status=1; continue;; esac
  case "$url" in https://*) ;; *) echo "FAILED $name: only https URLs are fetched"; status=1; continue;; esac
  out="$DIR/$name.s16"
  if [ -s "$out" ]; then echo "have $name"; continue; fi
  # --fail so an HTML error page never reaches ffmpeg and becomes silence; -L because these feeds redirect.
  if curl -fsSL --retry 3 --retry-delay 2 --max-time 1800 "$url" \
     | ffmpeg -v error -i - -ar 16000 -ac 1 -f s16le "$out" -y; then
    echo "got $name $(stat -c%s "$out") bytes"
  else
    rm -f "$out"; echo "FAILED $name"; status=1
  fi
done
exit $status
