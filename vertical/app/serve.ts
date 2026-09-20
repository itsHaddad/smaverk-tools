// serve.ts: static server for dist/ with the same COOP/COEP headers as Cloudflare Pages.  bun serve.ts [port]
const port = Number(process.argv[2] ?? 8791); const root = new URL("./dist/", import.meta.url).pathname;
// Cloudflare Pages serves /a-page from a-page.html; the search pages are addressed that way, so this does the same.
Bun.serve({ port, async fetch(req) { let p = new URL(req.url).pathname; if (p === "/") p = "/index.html"; else if (!p.split("/").pop()!.includes(".") && (await Bun.file(root + p + ".html").exists())) p += ".html"; const f = Bun.file(root + p); if (!(await f.exists())) return new Response("not found", { status: 404 }); return new Response(f, { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" } }); } });
console.log("serving dist on http://localhost:" + port);
