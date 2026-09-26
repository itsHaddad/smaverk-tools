// unlock.ts: how a Småverk tool becomes the paid version. The same file in every tool — captions/app, vertical/app,
// clipfinder/app and clips/app each carry a copy, and tests/site.test.ts fails if the copies differ, because tools that
// each invented their own unlocking is how one of them ended up hiding its key box inside a shut fold-out and
// another locked a paying customer out when the network was off.
//
// What it does, in the order it matters:
//   1. Back from a checkout the page unlocks itself. Nothing is copied, nothing is pasted.
//   2. One key opens whatever it is entitled to. The worker answers with a LIST of tools, so a bundle or a
//      subscription across the three is a change in the worker's map, not a change in any page.
//   3. A key that is already on the device keeps working when the worker cannot be reached. A paying customer
//      is never locked out by our own downtime, and the tools keep working with the network off.
//
// No media ever goes near any of this. The only requests here are about the key: one to our unlock worker, at
// page load and when a key is pasted. The work the tool does still makes none.

export type Tool = "captions" | "vertical" | "clipfinder" | "clips";

/** Where the key questions go. The pages talk to this and to nothing else about unlocking. */
const UNLOCK = "https://unlock.smaverk.com";
/** Polar's own portal: the person signs in with the email they paid with and reads their key back. */
const PORTAL = (sandbox: boolean) => (sandbox ? "https://sandbox.polar.sh/smaverk/portal" : "https://polar.sh/smaverk/portal");
/** One name on every tool, so the code is the same everywhere. Each site has its own storage; the key is what travels. */
const STORE = "smaverk.key";
/** The names the old per-tool storage used, read once so nobody who already paid has to paste again. */
const OLD_STORE: Record<Tool, string> = { captions: "smaverk.captions.key", vertical: "smaverk.vertical.key", clipfinder: "smaverk.clipfinder.key", clips: "smaverk.clips.key" };
/** What each tool is called in a sentence, and where it lives. */
export const TOOL_NAME: Record<Tool, string> = { captions: "Captions", vertical: "Vertical", clipfinder: "Clip finder", clips: "Clips" };
const TOOL_HOST: Record<Tool, string> = { captions: "https://captions.smaverk.com", vertical: "https://vertical.smaverk.com", clipfinder: "https://clipfinder.smaverk.com", clips: "https://clips.smaverk.com" };
/** A dated key keeps working this long after its date, so a failed card renewal does not stop work mid-clip. Nothing
 *  issues a dated key today; this is what a subscription would land on. */
const GRACE_DAYS = 7;

/**
 * A key of the shape and length Polar actually issues, for rigs that need the paid state without a rail.
 *
 * It lives here, in the file all three tools carry byte for byte, for the reason the whole module does: if one
 * tool can be audited in the paid state and another cannot, that difference finds its way back in. **Length is
 * the point.** The design review's overlapping tap targets only reproduced with a full-length key, because that
 * is what wraps; an eight-character stub would have shown a tidy panel and certified a state nobody had seen.
 */
export const SAMPLE_KEY: Record<Tool, string> = {
  captions: "SMV-60B88CE3-46C6-4FFC-83CE-AFDD6BA1A5BE",
  vertical: "VRT-564BA4A7-F187-49F7-AF0E-B53A520F8173",
  clipfinder: "SMVCF-7A1D9E02-4C88-4B3F-9E1A-D06F2B5C83",
  clips: "SMVCL-3E9B61C4-8D27-4F05-A6B3-1C7E4D92F0A8",
};

export type UnlockState = {
  /** Is the paid version on for THIS tool. */
  on: boolean;
  /** The key in full, or "". Shown to the person so they can carry it to another device. */
  key: string;
  /** Every tool this key opens, this one included. One today; three when a bundle is sold. */
  tools: Tool[];
  /** When the key stops working, or null for the one-off keys sold today. */
  expires: string | null;
  /** What to say right now. The page prints `text` and colours it with `tone`. */
  text: string;
  tone: "" | "ok" | "err";
  /** Set on the change that just happened, so a page can react (Captions re-saves without the mark). */
  became: "checkout" | "pasted" | "another-tab" | "removed" | "" ;
};

export type UnlockConfig = {
  tool: Tool;
  /** The sandbox rail, from ?rail=sandbox. Keeps test money away from real money. */
  sandbox: boolean;
  /** One line saying what the paid version of THIS tool gives, e.g. "No mark on your videos." */
  paidLine: string;
  /** Called on every change, including the first. The page owns its own painting. */
  render: (s: UnlockState) => void;
};

const IDLE = "Already paid? Paste your key here.";

export class Unlock {
  private cfg: UnlockConfig;
  private s: UnlockState;

  constructor(cfg: UnlockConfig) {
    this.cfg = cfg;
    this.s = { on: false, key: "", tools: [], expires: null, text: IDLE, tone: "", became: "" };
    // The checkout opens in its own tab so the clip being worked on stays put. When that tab comes back with the
    // key, this one picks it up without a reload.
    addEventListener("storage", (e: StorageEvent) => {
      if (e.key !== STORE || !e.newValue || this.s.on) return;
      // Quietly: the key may have been bought for another tool in that tab, and an error about someone else's
      // purchase has no business appearing on a page this person is in the middle of using.
      void this.apply(e.newValue, "another-tab", true);
    });
  }

  get state(): UnlockState {
    return this.s;
  }

  /** Where to send someone who has lost their key. */
  get portal(): string {
    return PORTAL(this.cfg.sandbox);
  }

  /** The other tools this key opens, each with a link that unlocks it in one click. */
  get elsewhere(): { tool: Tool; name: string; href: string }[] {
    return this.s.tools
      .filter((t) => t !== this.cfg.tool)
      .map((t) => ({ tool: t, name: TOOL_NAME[t], href: `${TOOL_HOST[t]}/?key=${encodeURIComponent(this.s.key)}${this.cfg.sandbox ? "&rail=sandbox" : ""}` }));
  }

  // ---- the three ways a key arrives ---------------------------------------------------------------------

  /**
   * Run once at load. In order: back from a checkout, a key handed over in the address, a key already here.
   * Never throws: a tool that cannot check a key still has to open.
   */
  async start(): Promise<void> {
    const u = new URL(location.href);
    const checkout = u.searchParams.get("checkout_id");
    const handed = u.searchParams.get("key");
    const clean = () => {
      for (const p of ["checkout_id", "customer_session_token", "paid", "key"]) u.searchParams.delete(p);
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
    };

    if (checkout) {
      this.set({ text: "Payment received. Fetching your key…", tone: "" });
      const key = await this.keyForCheckout(checkout);
      clean();
      if (key) await this.apply(key, "checkout");
      else
        this.set({
          text: "Payment received, but the key has not come through yet. It is in the email from Polar — paste it below, or use the link under the box to get it again.",
          tone: "err",
        });
      return;
    }

    if (handed) {
      // A link from another Småverk tool that this key also opens. It is the person's own key, and it leaves the
      // address bar immediately below.
      clean();
      // apply() writes the reason when it knows one — which tool the key DOES open, or that it has run out. Only
      // say something vaguer when it had nothing to say.
      if (!(await this.apply(handed, "pasted")) && this.s.tone !== "err") this.set({ text: "That key does not open this tool.", tone: "err" });
      return;
    }

    const saved = this.stored();
    if (!saved) return;
    // Trust the device first, then ask. A paying customer with a key already here must not sit and wait, and must
    // not be locked out because the worker is down or the network is off. Only a definite "no" takes it away.
    this.set({ on: true, key: saved, text: this.onText(), tone: "ok" });
    const answer = await this.ask(saved);
    if (answer === "unreachable") return;
    if (answer.tools.includes(this.cfg.tool) && !this.lapsed(answer.expires)) {
      this.set({ tools: answer.tools, expires: answer.expires, text: this.onText(answer.expires), tone: "ok" });
      return;
    }
    this.forget(answer.status === "granted" ? "That key does not open this tool." : "That key is no longer active. Write to hello@smaverk.com if that is wrong.", "err");
  }

  /** The Unlock button. Returns whether it worked, so the page can leave the box alone on a failure. */
  async paste(raw: string): Promise<boolean> {
    const key = raw.trim();
    if (!key) return false;
    this.set({ text: "Checking…", tone: "" });
    const ok = await this.apply(key, "pasted");
    if (ok) return true;
    // apply() has already written the reason when it knows one; this covers the case where it does not.
    if (this.s.tone !== "err") this.set({ text: "That key did not work here. Check the email from Polar, or use the link under the box to get it again.", tone: "err" });
    return false;
  }

  /**
   * "Remove the key from this device", and the one other way a key leaves: a definite no from the worker.
   * Removing it on purpose is an ordinary thing to do, so it is not painted as an error; being told the key is
   * no longer active is.
   */
  forget(why = "Key removed from this device. Paste it again any time.", tone: UnlockState["tone"] = ""): void {
    try {
      localStorage.removeItem(STORE);
      localStorage.removeItem(OLD_STORE[this.cfg.tool]);
    } catch {
      /* storage blocked: there was nothing to remove */
    }
    this.s = { on: false, key: "", tools: [], expires: null, text: why, tone, became: "removed" };
    this.cfg.render(this.s);
  }

  // ---- the parts that talk to the worker -----------------------------------------------------------------

  /**
   * Check a key and, if it opens this tool, turn the paid version on and remember it.
   * `quiet` suppresses the reasons it did not work: used when the key came from another tab rather than from
   * this person's hands, where an explanation would be an interruption about something they did not do here.
   */
  private async apply(key: string, became: UnlockState["became"], quiet = false): Promise<boolean> {
    const no = (text: string): false => {
      if (!quiet) this.set({ text, tone: "err" });
      return false;
    };
    const answer = await this.ask(key);
    if (answer === "unreachable") return no("Could not check the key right now. Try again in a minute.");
    if (answer.status !== "granted") return no("That key did not work here. Check the email from Polar, or use the link under the box to get it again.");
    if (this.lapsed(answer.expires)) return no("That key has run out. Renew it and it works again; everything already saved stays yours.");
    if (!answer.tools.includes(this.cfg.tool)) {
      const opens = answer.tools.map((t) => TOOL_NAME[t]).join(" and ");
      return no(opens ? `That key opens ${opens}, not ${TOOL_NAME[this.cfg.tool]}. Each tool is its own purchase.` : "That key does not open this tool.");
    }
    try {
      localStorage.setItem(STORE, key);
    } catch {
      /* storage blocked in this browser: the key works for this visit and has to be pasted again next time */
    }
    this.s = { on: true, key, tools: answer.tools, expires: answer.expires, text: this.thanks(became, answer.expires), tone: "ok", became };
    this.cfg.render(this.s);
    return true;
  }

  /** Ask the worker what a key opens. "unreachable" is NOT a no: it is "we could not find out". */
  private async ask(key: string): Promise<{ status: string; tools: Tool[]; expires: string | null } | "unreachable"> {
    try {
      const r = await fetch(`${UNLOCK}/entitlements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, rail: this.cfg.sandbox ? "sandbox" : "prod" }),
      });
      if (!r.ok) return "unreachable";
      const j: any = await r.json();
      if (typeof j?.status !== "string") return "unreachable";
      const tools = Array.isArray(j.tools) ? (j.tools.filter((t: unknown): t is Tool => t === "captions" || t === "vertical" || t === "clipfinder" || t === "clips") as Tool[]) : [];
      return { status: j.status, tools, expires: typeof j.expires === "string" ? j.expires : null };
    } catch {
      return "unreachable";
    }
  }

  /**
   * Straight after a checkout: ask the worker for the key that checkout bought. Polar grants the key a moment
   * after the payment settles, so this asks a few times before giving up rather than telling someone who has
   * just paid that nothing happened.
   */
  private async keyForCheckout(checkoutId: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await fetch(`${UNLOCK}/key?checkout_id=${encodeURIComponent(checkoutId)}${this.cfg.sandbox ? "&rail=sandbox" : ""}`);
        if (!r.ok) continue;
        const j: any = await r.json();
        if (j?.status === "granted" && typeof j.key === "string") return j.key;
        // A checkout that failed or was abandoned will never produce a key; only "pending" is worth waiting for.
        if (j?.status && !["pending", "confirmed", "succeeded"].includes(j.status)) return "";
      } catch {
        /* one failed attempt is not an answer; the loop tries again */
      }
    }
    return "";
  }

  // ---- small things --------------------------------------------------------------------------------------

  /** The key on this device, including one saved under a tool's old name before the tools shared one. */
  private stored(): string {
    try {
      const now = localStorage.getItem(STORE);
      if (now) return now;
      const old = localStorage.getItem(OLD_STORE[this.cfg.tool]);
      if (old) {
        localStorage.setItem(STORE, old);
        return old;
      }
    } catch {
      /* storage blocked in this browser: the key simply is not remembered */
    }
    return "";
  }

  /** Past its date, and past the grace days after it. Null never lapses, which is every key sold today. */
  private lapsed(expires: string | null): boolean {
    if (!expires) return false;
    const t = Date.parse(expires);
    if (!isFinite(t)) return false; // an unreadable date is not a reason to lock somebody out
    return Date.now() > t + GRACE_DAYS * 86400000;
  }

  private onText(expires: string | null = this.s.expires): string {
    const soon = expires && Date.parse(expires) < Date.now() ? ` It ran out on ${expires.slice(0, 10)}; it keeps working for ${GRACE_DAYS} days after that.` : "";
    return `${this.cfg.paidLine}${soon}`;
  }

  /**
   * Cold user, 2026-09-21: the old thank-you ran to five lines of green on a phone and repeated what the paid
   * panel printed two lines above it. What someone who has just paid needs to know is that they are done.
   */
  private thanks(became: UnlockState["became"], expires: string | null): string {
    if (became === "checkout") return `Thank you — nothing to paste. ${this.cfg.paidLine} Your key is above.`;
    return this.onText(expires);
  }

  private set(p: Partial<UnlockState>): void {
    this.s = { ...this.s, ...p, became: p.became ?? "" };
    this.cfg.render(this.s);
  }
}
