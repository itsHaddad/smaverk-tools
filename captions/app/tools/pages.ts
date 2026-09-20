#!/usr/bin/env bun
// pages.ts: the search pages of this tool, made from dist/index.html and pages/*.json.
// One look, one fix: everything except the words listed below is copied from the home page byte for byte, so a change
// to the home page (a price, a control, a style rule) reaches every page at the next build and none of them can drift.
// build.sh runs this AFTER the version stamps, so a generated page carries the same app.js and media stamps as the home
// page without a second sed. Running it twice changes nothing: each page is a function of dist/index.html and its json.
// Both tools carry the same copy of this file (tests/site.test.ts: "shared parts are the same file in every tool").
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Source = { text: string; url: string };
export type Question = { q: string; a: string; source: Source };
export type Link = { text: string; href: string };
export type Page = {
  slug: string;          // the address: /<slug>, served from dist/<slug>.html
  title: string;         // <title>, under 60 characters
  description: string;   // meta description, under 155 characters
  ogTitle: string; ogDescription: string;
  h1: string;
  sub: string;           // the line under the headline: starts "AI " and says "on your device." in its first sentence
  crumb: string;         // this page's name in the breadcrumb
  style?: string;        // the look the sample opens in, with no query string (app.ts reads it off <body>)
  body: string[];        // paragraphs; [text](https://…) becomes a link
  not: string[];         // "What it does not do"
  questions: Question[]; // closed at rest: the answers are in the page for readers and search engines, not in the way
  more: Link[];          // up to the home page, across to a sibling, over to the other tool
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const link = (text: string, href: string) => `<a href="${attr(href)}" rel="noopener">${esc(text)}</a>`;
// [words](https://…) becomes a plain link. Nothing else is markup, so a stray bracket cannot open a tag.
const inline = (s: string) => esc(s).replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => link(t, u));

const must = (html: string, re: RegExp, what: string) => {
  const m = html.match(re);
  if (!m) throw new Error(`pages.ts: ${what} not found in dist/index.html — the home page changed shape; fix this file, do not hand-write a page`);
  return m[0];
};
const swap = (html: string, re: RegExp, to: string, what: string) => { must(html, re, what); return html.replace(re, () => to); };

export function renderPage(index: string, page: Page): string {
  const origin = new URL(must(index, /<link rel="canonical" href="[^"]+">/, "canonical").match(/href="([^"]+)"/)![1]!).origin;
  const tool = must(index, /<a class="brand"[^>]*>[\s\S]*?<span>([^<]*)<\/span>/, "the tool's name in the brand link").match(/<span>([^<]*)<\/span>/)![1]!;
  const url = `${origin}/${page.slug}`;
  let html = index;

  // head: what this page is, and that it is its own page
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`, "title");
  html = swap(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(page.description)}">`, "description");
  html = swap(html, /<link rel="canonical" href="[^"]+">/, `<link rel="canonical" href="${attr(url)}">`, "canonical");
  html = swap(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${attr(page.ogTitle)}">`, "og:title");
  html = swap(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${attr(page.ogDescription)}">`, "og:description");
  html = swap(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${attr(url)}">`, "og:url");
  html = swap(html, /<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${attr(page.ogTitle)}">`, "twitter:title");
  html = swap(html, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${attr(page.ogDescription)}">`, "twitter:description");

  // Structured data. The FAQ rich result ended on 7 May 2026, so FAQPage earns nothing and goes; the software app keeps
  // no rating (we have none, and an invented one is forbidden); the breadcrumb still shows in results.
  html = swap(html, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"FAQPage"[\s\S]*?<\/script>\n/, "", "the FAQPage block");
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: tool, item: `${origin}/` },
    { "@type": "ListItem", position: 2, name: page.crumb, item: url },
  ] };
  const app = must(html, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"SoftwareApplication"[\s\S]*?<\/script>/, "the SoftwareApplication block");
  html = html.replace(app, () => `${app}\n<script type="application/ld+json">${JSON.stringify(crumbs)}</script>`);

  // the sample opens in this page's look, with no query string to click through
  html = swap(html, /<body>/, page.style ? `<body data-style="${attr(page.style)}">` : "<body>", "the body tag");

  // the two lines that say what this page is for
  html = swap(html, /<h1>[\s\S]*?<\/h1>/, `<h1>${inline(page.h1)}</h1>`, "the headline");
  html = swap(html, /<p class="sub">[\s\S]*?<\/p>/, `<p class="sub">${esc(page.sub)}</p>`, "the line under the headline");

  // everything under the key box, down to the footer: this page's own words. The price box, the pay steps and the key
  // box above it stay as they are on the home page.
  const keyEnd = html.indexOf("</p>", html.indexOf(`<p class="fine" id="keystatus">`));
  const foot = html.indexOf(`<p class="foot">`);
  if (keyEnd < 0 || foot < 0 || foot < keyEnd) throw new Error("pages.ts: the key box or the footer moved in dist/index.html");
  const I = "\n      ";
  const sections = [
    ...page.body.map((p) => `<p>${inline(p)}</p>`),
    `<h2>What it does not do</h2>`,
    `<ul>${page.not.map((n) => `<li>${inline(n)}</li>`).join("")}</ul>`,
    ...page.questions.map((q) => `<details><summary>${esc(q.q)}</summary><p>${inline(q.a)} ${link(q.source.text, q.source.url)}</p></details>`),
    `<h2>More ways to use it</h2>`,
    `<ul>${page.more.map((m) => `<li><a href="${attr(m.href)}">${esc(m.text)}</a></li>`).join("")}</ul>`,
  ].join(I);
  return html.slice(0, keyEnd + 4) + "\n" + I + sections + "\n\n      " + html.slice(foot);
}

export function readPages(app: string): Page[] {
  const dir = join(app, "pages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => { const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Page;
      if (p.slug !== f.replace(/\.json$/, "")) throw new Error(`pages.ts: ${f} names the slug "${p.slug}"`);
      return p; });
}

if (import.meta.main) {
  const app = new URL("..", import.meta.url).pathname;
  const index = readFileSync(join(app, "dist/index.html"), "utf8");
  const made: string[] = [];
  for (const page of readPages(app)) { writeFileSync(join(app, `dist/${page.slug}.html`), renderPage(index, page)); made.push(page.slug); }
  console.log(`pages: ${made.length ? made.join(", ") : "none"}`);
}
