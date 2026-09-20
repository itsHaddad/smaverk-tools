# Speech recogniser bench

Measures what on-device speech models cost and produce on long recordings: real-time factor, memory,
and the transcript itself. Built because published word-error numbers are measured on short read
speech, and a tool that transcribes an hour-long talk in a browser tab needs numbers from hour-long
talks on ordinary hardware.

It transcribes public audio, and that is all it does. Give it a list of references, a model and a time
slice; it returns transcripts as artifacts. It scores nothing and decides nothing.

```
bun bench/asr/transcribe.ts --ref <youtube-id> --model tiny --from 0 --to 3600
bun bench/asr/embed.ts      --in transcript.json --model minilm
```

## Models

| Key | Model | Licence | Size (int8) |
|---|---|---|---|
| `tiny` | `onnx-community/whisper-tiny_timestamped` | Apache-2.0 weights | 38.9 MB |
| `tiny.en` | `onnx-community/whisper-tiny.en_timestamped` | Apache-2.0 weights | 38.9 MB |
| `base` | `onnx-community/whisper-base_timestamped` | Apache-2.0 weights | 73.3 MB |
| `small` | `onnx-community/whisper-small_timestamped` | Apache-2.0 weights | 237.5 MB |
| `moonshine-tiny` | `onnx-community/moonshine-tiny-ONNX` | MIT | ~27 MB |
| `moonshine-base` | `onnx-community/moonshine-base-ONNX` | MIT | ~61 MB |

Embedding models, for the segmentation experiments:

| Key | Model | Licence | Size (int8) |
|---|---|---|---|
| `minilm` | `Xenova/all-MiniLM-L6-v2` | Apache-2.0 | 21.9 MB |
| `potion` | `minishlab/potion-base-8M` | MIT | ~32 MB |

Sizes are read off the published files rather than quoted from a card. Several popular alternatives
are not usable commercially — Jina's v3 embeddings and rerankers are CC-BY-NC-4.0, `nomic-embed-vision`
likewise, and the Gemma family carries its own licence with a prohibited-use policy — so the licence is
checked against the file that is actually downloaded.

## Costs runner minutes

Transcription runs at roughly half of real time on two cores, so an hour of audio is half an hour of
runner time. Keep slices short, run a few first, and read the numbers before asking for more.
