#!/usr/bin/env bun
// Sentence embeddings for a transcript, for segmentation experiments.
//
//   bun bench/asr/embed.ts --in transcript.json --model minilm
//   bun bench/asr/embed.ts --in transcript.json --model potion
//
// Topic segmenters that compare literal word overlap between neighbouring stretches of talk are
// fragile in exactly the way speech recognition is unreliable: one substituted word removes the
// overlap while leaving the subject untouched. Comparing embeddings instead asks about meaning, which
// survives a wrong word. This produces the embeddings; what is done with them lives elsewhere.
//
// Two models, because they cost very different things:
//
//   minilm  all-MiniLM-L6-v2, Apache-2.0, 22 MB at int8. A real encoder: a transformer pass per
//           sentence.
//   potion  potion-base-8M, MIT, 29 MB. A STATIC model — a lookup table distilled from a sentence
//           transformer, so an embedding costs a table lookup per token and no forward pass at all.
//           If it holds most of the boundary quality it is close to free, which is the whole point of
//           benchmarking it next to a real encoder rather than instead of one.
//
// The text is cut into fixed runs of content-bearing words rather than sentences, because machine
// transcripts of speech have no reliable sentence punctuation.

import { join } from "node:path";

export const EMBED_MODELS: Record<string, string> = {
  minilm: "Xenova/all-MiniLM-L6-v2",
  potion: "minishlab/potion-base-8M",
};

/** Closed-class words carry no subject, so they are not what a block should be measured on. */
const STOP = new Set(
  ("a about all also am an and any are as at be because been but by can could did do does doing done down each even " +
    "for from further get go going got had has have having he her here hers him his how i if in into is it its just " +
    "know like made make many me might more most much must my no nor not now of off on once one only or other our out " +
    "over own really right said same say says see she should so some such than that the their theirs them then there " +
    "these they thing things think this those through to too up us very was way we well were what when where which " +
    "while who whom why will with would yeah yes you your yours actually basically kind lot mean okay sort thank " +
    "thanks gonna wanna oh uh um hmm")
    .split(" "),
);

export const TOKENS_PER_BLOCK = 20;

export type Word = { t: number; text: string };

/** Fixed runs of content words, with the time each run starts. */
export function blocks(words: Word[], size = TOKENS_PER_BLOCK): { text: string; startS: number }[] {
  const out: { text: string; startS: number }[] = [];
  let buf: string[] = [];
  let startS = 0;
  let kept = 0;
  for (const w of words) {
    if (!buf.length) startS = w.t;
    buf.push(w.text);
    const bare = w.text.toLowerCase().replace(/[^a-z']/g, "");
    if (bare.length >= 2 && !STOP.has(bare)) kept++;
    if (kept >= size) {
      out.push({ text: buf.join(" "), startS });
      buf = [];
      kept = 0;
    }
  }
  if (kept >= size / 2) out.push({ text: buf.join(" "), startS });
  return out;
}

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};

/**
 * Model2Vec's ONNX is an EmbeddingBag: it wants a flat run of token ids plus the offset where each
 * text begins, which is not the shape transformers.js builds for an encoder, so the pipeline fails
 * with "Missing the following inputs: offsets". Driving the session directly is a dozen lines and
 * avoids pretending a static model is a transformer.
 *
 * This is also what makes the model interesting: there is no forward pass, only a lookup and a mean.
 */
async function potionEmbedder(model: string, threads: number) {
  const [{ AutoTokenizer }, ort] = await Promise.all([import("@huggingface/transformers"), import("onnxruntime-node")]);
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const url = `https://huggingface.co/${model}/resolve/main/onnx/model.onnx`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
  const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
  return async (texts: string[]) => {
    const ids: bigint[] = [];
    const offsets: bigint[] = [];
    for (const text of texts) {
      offsets.push(BigInt(ids.length));
      const enc = await tokenizer(text, { add_special_tokens: false });
      for (const v of enc.input_ids.data as BigInt64Array) ids.push(v);
      // An empty encoding would make two texts share an offset and silently merge them.
      if (BigInt(ids.length) === offsets[offsets.length - 1]!) ids.push(0n);
    }
    const out = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids), [ids.length]),
      offsets: new ort.Tensor("int64", BigInt64Array.from(offsets), [offsets.length]),
    });
    const t = out[session.outputNames[0]!]!;
    const data = t.data as Float32Array;
    const dim = data.length / texts.length;
    const rows: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      const v = data.slice(i * dim, (i + 1) * dim) as Float32Array;
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < v.length; k++) v[k]! /= n;
      rows.push(v);
    }
    return rows;
  };
}

if (import.meta.main) {
  const inPath = arg("in");
  const modelKey = arg("model", "minilm")!;
  const model = EMBED_MODELS[modelKey];
  if (!inPath || !model) {
    console.error(`usage: --in <transcript.json> --model <${Object.keys(EMBED_MODELS).join("|")}>`);
    process.exit(2);
  }
  const doc = JSON.parse(await Bun.file(inPath).text()) as { ref: string; words: Word[] };
  const parts = blocks(doc.words);
  if (!parts.length) throw new Error(`${inPath} produced no blocks — is it empty?`);

  const threads = Number(arg("threads", "2"));
  const t0 = performance.now();
  let embed: (texts: string[]) => Promise<Float32Array[]>;
  if (modelKey === "potion") {
    embed = await potionEmbedder(model, threads);
  } else {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    const extractor = await pipeline("feature-extraction", model, {
      dtype: "q8",
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    } as any);
    embed = async (texts: string[]) => {
      const res = await extractor(texts, { pooling: "mean", normalize: true });
      const data = res.data as Float32Array;
      const dim = data.length / texts.length;
      return texts.map((_, k) => data.slice(k * dim, (k + 1) * dim) as Float32Array);
    };
  }
  const loadMs = performance.now() - t0;

  const t1 = performance.now();
  const rows: Float32Array[] = [];
  const batch = 32;
  for (let i = 0; i < parts.length; i += batch) rows.push(...(await embed(parts.slice(i, i + batch).map((p) => p.text))));
  const embedMs = performance.now() - t1;
  const dim = rows[0]!.length;

  const flat = new Float32Array(rows.length * dim);
  for (const [i, r] of rows.entries()) flat.set(r, i * dim);
  const outDir = arg("out", process.env.BENCH_OUT ?? join(process.cwd(), "bench", "embeds"))!;
  await Bun.write(join(outDir, `${doc.ref}.${modelKey}.f32`), flat.buffer as ArrayBuffer);
  await Bun.write(
    join(outDir, `${doc.ref}.${modelKey}.json`),
    JSON.stringify({ ref: doc.ref, model: modelKey, dim, rows: rows.length, starts: parts.map((p) => +p.startS.toFixed(2)) }),
  );
  console.log(
    JSON.stringify({
      ref: doc.ref,
      model: modelKey,
      blocks: rows.length,
      dim,
      load_ms: Math.round(loadMs),
      embed_ms: Math.round(embedMs),
      blocks_per_s: +(rows.length / (embedMs / 1000)).toFixed(1),
    }),
  );
}
