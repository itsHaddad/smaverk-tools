#!/usr/bin/env bash
# Audio for one or more references as 16 kHz mono raw PCM, which is what the transcriber reads.
set -u
DIR=${BENCH_AUDIO:-bench/audio}
mkdir -p "$DIR"
status=0
for ref in "$@"; do
  out="$DIR/$ref.s16"
  if [ -s "$out" ]; then echo "have $ref"; continue; fi
  if yt-dlp -f bestaudio --no-playlist -q --no-warnings -o - "https://www.youtube.com/watch?v=$ref" \
     | ffmpeg -v error -i - -ar 16000 -ac 1 -f s16le "$out" -y; then
    echo "got $ref $(stat -c%s "$out") bytes"
  else
    rm -f "$out"; echo "FAILED $ref"; status=1
  fi
done
exit $status
