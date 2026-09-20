// theme.ts: the page's own colours, in a form a canvas will accept.
//
// The page writes its palette as `light-dark(a, b)` custom properties, which is right for CSS and
// useless for a canvas: getComputedStyle hands a custom property back exactly as written, and a canvas
// SILENTLY IGNORES a fillStyle it cannot parse, keeping whatever was set before — black, at the start.
// So every colour on the recording map and on the three length buttons was being dropped, and the map
// painted black on black with its text invisible inside it.
//
// The cold user, 2026-09-21, first screen, before anything else she said: "a large solid black
// rectangle … it made me wonder whether the page had failed." Five earlier gate runs missed it because
// they measure geometry and console errors, and a canvas that quietly paints black raises neither.

/**
 * Resolve one `light-dark(a, b)` value for the scheme in force. Anything else is handed back as it came,
 * so a plain hex or a font stack (which has commas of its own) passes through untouched.
 */
export function pickScheme(value: string, dark: boolean): string {
  const v = value.trim();
  if (!v.toLowerCase().startsWith("light-dark(")) return v;
  const inner = v.slice(v.indexOf("(") + 1, v.lastIndexOf(")"));
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return (dark ? inner.slice(i + 1) : inner.slice(0, i)).trim();
  }
  return inner.trim(); // one argument only: malformed, but a colour is better than nothing
}
