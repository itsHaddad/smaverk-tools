// pricing.ts: what the page says about money, and who has to pay, in one place.
//
// The tool was free while it was new (2026-09-21 to 22) and is $50 once since (the owner, 2026-09-22).
// Both states are written here side by side, tested, so switching between them never means writing copy
// under time pressure. Nothing here touches the DOM, so both states are testable.

/** Every sentence the page says about money once a number exists. */
export type PriceCopy = {
  /** The pill beside the name at the top of the page. */
  tag: string;
  /** The big number, and the word under it. */
  amount: string;
  per: string;
  /** The button that opens the checkout. */
  buy: string;
  /** What the money buys, under the block. */
  fine: string;
  /** The line under the main button: what it costs, what language, where it runs. */
  trust: string;
};

/**
 * The paid page, written from one number.
 *
 * Both halves of the offer are named everywhere the visitor might land, because a limit found after
 * the work is done is what earns one-star reviews (Kapwing, Trustpilot, 12 Apr 2026).
 */
export function priceCopy(price: string): PriceCopy {
  return {
    tag: `Free · ${price} once`,
    amount: price,
    per: "once",
    buy: `Buy once — ${price}`,
    fine: "Saving is the paid half.",
    trust: "Free up to 30 minutes, without saving. English. Your recording stays on your device.",
  };
}

/** What the page says while it is free, so the two states are written side by side and cannot drift. */
export const TRIAL_COPY: Omit<PriceCopy, "buy"> = {
  tag: "Free while it is new",
  amount: "Free",
  per: "while it is new",
  fine: "Everything is open while this is new: recordings up to four hours, and every export.",
  trust: "Free while it is new. English. Your recording stays on your device.",
};

/**
 * Whether saving has to be paid for. The whole paywall turns on this one answer.
 *
 * While the tool is free nobody is ever asked, including a visitor who arrives with a key from
 * somewhere: `licensed` still opens everything, it just no longer opens anything extra.
 */
export const mustPay = (trial: boolean, licensed: boolean): boolean => !trial && !licensed;

/** How much of a recording gets read, in seconds. Free reads half an hour; the trial reads all four. */
export const readLimitS = (trial: boolean, licensed: boolean, freeS: number, paidS: number): number =>
  trial || licensed ? paidS : freeS;
