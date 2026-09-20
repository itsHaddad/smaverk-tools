// page.test.ts: the parts of the page that are not the finding pipeline — the colours a canvas is given,
// and the sentences said when there is nothing to show. Both were faults a cold user found in one sitting
// (2026-09-21) and both are pure functions here so they can never be wrong silently again.
import { test, expect } from "bun:test";
import { pickScheme } from "../src/lib/theme";
import { nothingFoundLine, otherLengths } from "../src/lib/advice";

test("a light-dark colour resolves to something a canvas will accept", () => {
  // A canvas ignores a fillStyle it cannot parse and keeps the last one, so an unresolved token is not a
  // visible error — it is a black rectangle where the recording should be.
  expect(pickScheme("light-dark(#F3F2F7,#0E0D12)", false)).toBe("#F3F2F7");
  expect(pickScheme("light-dark(#F3F2F7,#0E0D12)", true)).toBe("#0E0D12");
  expect(pickScheme(" light-dark( #FFFFFF , #18161F ) ", true)).toBe("#18161F");
  expect(pickScheme("LIGHT-DARK(#fff,#000)", false)).toBe("#fff");
  // A colour with commas inside it splits at the top level only.
  expect(pickScheme("light-dark(rgb(255, 255, 255), rgb(0, 0, 0))", true)).toBe("rgb(0, 0, 0)");
  expect(pickScheme("light-dark(color-mix(in oklab, #fff 20%, #000), #111)", false)).toBe("color-mix(in oklab, #fff 20%, #000)");
  // Anything that is not a light-dark() comes back as it came: plain colours, and font stacks.
  expect(pickScheme("#FFD84D", true)).toBe("#FFD84D");
  expect(pickScheme('"Bricolage Grotesque", ui-sans-serif, sans-serif', true)).toBe('"Bricolage Grotesque", ui-sans-serif, sans-serif');
  expect(pickScheme("", false)).toBe("");
  // Malformed rather than empty: one argument still yields a colour instead of nothing.
  expect(pickScheme("light-dark(#abc)", true)).toBe("#abc");
});

test("when nothing is found, the page names a length that exists and never the one just tried", () => {
  const OFFERED = [60, 180, 300];
  // The fault: at the shortest length it said "Try a shorter clip length".
  const shortest = nothingFoundLine(60, OFFERED);
  expect(shortest).toContain("3 min");
  expect(shortest).toContain("5 min");
  expect(shortest).not.toMatch(/shorter/);
  for (const targetS of OFFERED) {
    const line = nothingFoundLine(targetS, OFFERED);
    const own = targetS === 60 ? "1 min" : targetS === 180 ? "3 min" : "5 min";
    // It says what it looked for, then the other lengths — and never offers the one already chosen.
    expect(line, `${own}: says what it looked for`).toContain(own);
    expect(line.slice(line.indexOf("Try")), `${own}: does not offer itself`).not.toContain(own);
    for (const other of otherLengths(targetS, OFFERED)) expect(line, `${own}: offers ${other} s`).toContain(other === 60 ? "1 min" : other === 180 ? "3 min" : "5 min");
  }
  // One length on the page, and there is nothing to suggest: it says what happened and stops.
  expect(nothingFoundLine(60, [60])).toBe("Nothing in this one stayed on a single subject for a whole 1 min.");
  expect(otherLengths(60, [60, 180, 300])).toEqual([180, 300]);
});
