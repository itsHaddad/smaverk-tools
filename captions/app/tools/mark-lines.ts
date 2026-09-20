// mark-lines.ts: writes the tool's own line breaks into dist/sample-words.json ("br": true on the last word of each line), so the
// studio card shows exactly the lines the tool shows. Run by build.sh; safe to run again.
import { buildLines, type Word } from "../src/lib/lines";
const file = new URL("../dist/sample-words.json", import.meta.url).pathname;
const words: (Word & { br?: boolean })[] = JSON.parse(await Bun.file(file).text());
for (const w of words) delete w.br;
for (const l of buildLines(words)) words[l.idx[l.idx.length - 1]!]!.br = true;
await Bun.write(file, JSON.stringify(words));
console.log("lines: " + buildLines(words).map((l) => l.ws.map((w) => w.text).join(" ")).join(" | "));
