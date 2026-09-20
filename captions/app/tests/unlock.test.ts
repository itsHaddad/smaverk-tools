// What unlocking actually does, run against the real module rather than its shape.
//
// One copy of this test for the studio: tests/site.test.ts asserts that all three tools carry the same
// src/lib/unlock.ts byte for byte, so exercising Captions' copy exercises Vertical's and the clip finder's.
//
// The module talks to the page and to the network, so both are stood up here as small fakes. What is real is
// every decision it makes: when a key is kept, when it is thrown away, when our own downtime must not lock a
// paying customer out, and what a key that opens more than one tool does.
import { test, expect, beforeEach } from "bun:test";
import type { UnlockState } from "../src/lib/unlock";

// ---- the page and the network, faked ----------------------------------------------------------------

let store: Record<string, string> = {};
let storageWorks = true;
let answers: any[] = [];
let asked: { url: string; body: any }[] = [];

const g = globalThis as any;
g.addEventListener = () => {};
g.localStorage = {
  getItem: (k: string) => {
    if (!storageWorks) throw new Error("storage blocked");
    return store[k] ?? null;
  },
  setItem: (k: string, v: string) => {
    if (!storageWorks) throw new Error("storage blocked");
    store[k] = v;
  },
  removeItem: (k: string) => {
    if (!storageWorks) throw new Error("storage blocked");
    delete store[k];
  },
};
let href = "https://captions.smaverk.com/";
g.location = { get href() { return href; } };
g.history = { replaceState: (_a: unknown, _b: unknown, to: string) => { href = new URL(to, "https://captions.smaverk.com/").href; } };
g.fetch = async (url: string, init?: any) => {
  asked.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  const next = answers.shift();
  if (next === "down") throw new Error("network down");
  if (next === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => next };
};

const { Unlock } = await import("../src/lib/unlock");

/** Build an Unlock and capture every state it paints. */
function make(tool: "captions" | "vertical" | "clipfinder" = "captions") {
  const seen: UnlockState[] = [];
  const u = new Unlock({ tool, sandbox: false, paidLine: "No mark.", render: (s) => seen.push({ ...s }) });
  return { u, seen, last: () => seen[seen.length - 1]! };
}
const granted = (tools: string[], expires: string | null = null) => ({ status: "granted", tools, expires });
const DAY = 86400000;

beforeEach(() => {
  store = {};
  storageWorks = true;
  answers = [];
  asked = [];
  href = "https://captions.smaverk.com/";
});

// ---- the one that reached a paying customer ---------------------------------------------------------

test("a key already on the device survives the worker being unreachable", async () => {
  store["smaverk.key"] = "SMV-AAAA";
  answers = ["down"];
  const { u, last } = make();
  await u.start();
  expect(last().on, "a paying customer must not be locked out by our own downtime").toBe(true);
  expect(store["smaverk.key"], "and the key must not be thrown away").toBe("SMV-AAAA");
});

test("a key already on the device works before the check comes back", async () => {
  store["smaverk.key"] = "SMV-AAAA";
  answers = [granted(["captions"])];
  const { u, seen } = make();
  await u.start();
  expect(seen[0]!.on, "the paid version is on from the first paint, not after a round trip").toBe(true);
});

test("a key the worker says is dead is removed", async () => {
  store["smaverk.key"] = "SMV-REFUNDED";
  answers = [{ status: "revoked", tools: [], expires: null }];
  const { u, last } = make();
  await u.start();
  expect(last().on).toBe(false);
  expect(store["smaverk.key"], "a refunded key does not linger").toBeUndefined();
  expect(last().tone).toBe("err");
});

// ---- one key, several tools -------------------------------------------------------------------------

test("a key for another tool is refused, and says what it does open", async () => {
  answers = [granted(["vertical"])];
  const { u, last } = make("captions");
  expect(await u.paste("VRT-1234")).toBe(false);
  expect(last().on).toBe(false);
  expect(last().text).toContain("opens Vertical, not Captions");
  expect(store["smaverk.key"], "a key that opens nothing here is not kept").toBeUndefined();
});

test("one key can open the whole studio, and says where else it works", async () => {
  answers = [granted(["captions", "vertical", "clipfinder"])];
  const { u, last } = make("captions");
  expect(await u.paste("SMV-BUNDLE")).toBe(true);
  expect(last().on).toBe(true);
  expect(last().tools).toEqual(["captions", "vertical", "clipfinder"]);
  const others = u.elsewhere;
  expect(others.map((o) => o.name)).toEqual(["Vertical", "Clip finder"]);
  // The link carries the key, so the second tool is one click and not another paste.
  expect(others[0]!.href).toBe("https://vertical.smaverk.com/?key=SMV-BUNDLE");
  expect(others[1]!.href).toContain("clipfinder.smaverk.com");
});

test("the page asks the worker, and sends nothing but the key and the rail", async () => {
  answers = [granted(["captions"])];
  const { u } = make();
  await u.paste("SMV-1234");
  expect(asked).toHaveLength(1);
  expect(asked[0]!.url).toBe("https://unlock.smaverk.com/entitlements");
  expect(asked[0]!.body).toEqual({ key: "SMV-1234", rail: "prod" });
});

// ---- coming back from a checkout ---------------------------------------------------------------------

test("coming back from a checkout unlocks the page with nothing pasted", async () => {
  href = "https://captions.smaverk.com/?checkout_id=11111111-2222-3333-4444-555555555555";
  answers = [{ status: "granted", key: "SMV-NEW", tools: ["captions"] }, granted(["captions"])];
  const { u, last } = make();
  await u.start();
  expect(last().on, "the person who just paid does not have to do anything").toBe(true);
  expect(last().key).toBe("SMV-NEW");
  expect(store["smaverk.key"]).toBe("SMV-NEW");
  expect(href, "and the checkout id does not stay in the address").not.toContain("checkout_id");
});

test("a checkout that never grants a key says so instead of failing silently", async () => {
  href = "https://captions.smaverk.com/?checkout_id=11111111-2222-3333-4444-555555555555";
  answers = Array(6).fill({ status: "failed" });
  const { u, last } = make();
  await u.start();
  expect(last().on).toBe(false);
  expect(last().text).toContain("Payment received");
  expect(last().tone).toBe("err");
});

test("a key handed over in a link unlocks the tool it was sent to", async () => {
  href = "https://captions.smaverk.com/?key=SMV-BUNDLE";
  answers = [granted(["captions", "vertical"])];
  const { u, last } = make();
  await u.start();
  expect(last().on).toBe(true);
  expect(href, "the key does not stay in the address bar").not.toContain("key=");
});

// ---- dated keys: what a subscription would land on -----------------------------------------------------

test("a key with a date still works inside its grace days, and stops after them", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
  answers = [granted(["captions"], twoDaysAgo)];
  const a = make();
  expect(await a.u.paste("SMV-LAPSING")).toBe(true);
  expect(a.last().text, "and it says what has happened").toContain("keeps working for 7 days");

  const longGone = new Date(Date.now() - 30 * DAY).toISOString();
  answers = [granted(["captions"], longGone)];
  const b = make();
  expect(await b.u.paste("SMV-LAPSED")).toBe(false);
  expect(b.last().text).toContain("has run out");
});

test("no date means it never runs out, which is every key sold today", async () => {
  answers = [granted(["captions"], null)];
  const { u, last } = make();
  expect(await u.paste("SMV-FOREVER")).toBe(true);
  expect(last().expires).toBe(null);
});

// ---- the awkward browsers -------------------------------------------------------------------------------

test("a browser that blocks storage still unlocks for this visit", async () => {
  storageWorks = false;
  answers = [granted(["captions"])];
  const { u, last } = make();
  expect(await u.paste("SMV-1234")).toBe(true);
  expect(last().on, "storage being blocked is not a reason to refuse a paid key").toBe(true);
});

test("a key saved under a tool's old name is carried over, not asked for again", async () => {
  store["smaverk.captions.key"] = "SMV-OLD";
  answers = [granted(["captions"])];
  const { u, last } = make();
  await u.start();
  expect(last().on, "nobody who already paid should have to paste again").toBe(true);
  expect(store["smaverk.key"], "and it moves to the name every tool shares").toBe("SMV-OLD");
});

test("removing the key is an ordinary thing to do, not an error", async () => {
  store["smaverk.key"] = "SMV-1234";
  const { u, last } = make();
  u.forget();
  expect(last().on).toBe(false);
  expect(last().tone, "removing a key on purpose is not painted red").toBe("");
  expect(store["smaverk.key"]).toBeUndefined();
});

test("an empty box does nothing at all", async () => {
  const { u } = make();
  expect(await u.paste("   ")).toBe(false);
  expect(asked, "an empty box does not go to the network").toHaveLength(0);
});

test("the way back to a lost key is Polar's own portal", () => {
  expect(make().u.portal).toBe("https://polar.sh/smaverk/portal");
  const sandbox = new Unlock({ tool: "captions", sandbox: true, paidLine: "", render: () => {} });
  expect(sandbox.portal).toBe("https://sandbox.polar.sh/smaverk/portal");
});
