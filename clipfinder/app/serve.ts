// serve.ts: static server for dist/ with the same headers Cloudflare Pages sends.  bun serve.ts [port]
const port = Number(process.argv[2] ?? 8811);
const root = new URL("./dist/", import.meta.url).pathname;
Bun.serve({
  port,
  async fetch(req) {
    let p = new URL(req.url).pathname;
    if (p === "/") p = "/index.html";
    else if (!p.split("/").pop()!.includes(".") && (await Bun.file(`${root}${p}.html`).exists())) p += ".html";
    const f = Bun.file(root + p);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } });
  },
});
console.log(`serving dist on http://localhost:${port}`);
