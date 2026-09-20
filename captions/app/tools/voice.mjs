// voice.mjs: sample voice-over with Kokoro (Apache-2.0 TTS), 24 kHz WAV. Run with node:  node tools/voice.mjs "<text>" out.wav [voice]
import { KokoroTTS } from "kokoro-js";
const [text, outPath, voice = "af_heart"] = process.argv.slice(2);
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
const audio = await tts.generate(text, { voice, speed: 1.0 });
await audio.save(outPath);
console.log(`wrote ${outPath} ${(audio.audio.length / audio.sampling_rate).toFixed(1)}s`);
