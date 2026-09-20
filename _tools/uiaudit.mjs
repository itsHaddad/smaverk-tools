// uiaudit.mjs: the in-page UI audit every mission's state-matrix test runs at each state (see References/UiStandard.md,
// "States and inputs"). Generic: nothing here knows the product. Import from a mission's tests/e2e/verify-ui.mjs:
//   const { auditPage, judge } = await import(`${process.env.PAI_DIR ?? process.env.HOME + "/.claude"}/skills/Missions/Tools/uiaudit.mjs`);
//   const f = await auditPage(page, [".stage", "#action", ".chips"]);   judge(f, "loaded-longname", check, { baseFont });
//
// What it measures, in the viewer's browser:
//   sideways  the document is wider than the viewport (on iPhone this shows as the page "zooming")
//   beyond    visible elements that stick out past the left or right edge (ignoring ones an ancestor clips)
//   spill     text nodes wider than their box in an element that neither wraps nor clips (long names, keys, emails)
//   widths    the measured width of the elements you name, so a column can be checked for one width
//   scale     visualViewport.scale (must stay 1); font  the body font size (must not change between states)

/** Run the audit inside the page. `columns` are selectors whose widths should agree. */
export function auditPage(page, columns = []) {
  return page.evaluate((columns) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
    const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "hidden" || o === "clip" || o === "auto" || o === "scroll") return true; } return false; };
    const W = innerWidth;
    const shown = (e) => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none" && +c.opacity > 0.05 && !e.closest(".sr,[aria-hidden=true]"); };
    const smallText = []; for (const e of document.querySelectorAll("body *")) { if (!shown(e) || e.closest("canvas,svg,video")) continue; const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1); if (!own) continue; const px = parseFloat(getComputedStyle(e).fontSize); if (px < 15) smallText.push(`${e.id ? "#" + e.id : e.tagName.toLowerCase()} ${px}px "${e.textContent.trim().slice(0, 24)}"`); }
    const smallTargets = []; for (const e of document.querySelectorAll("button,a[href],input:not([type=hidden]):not([type=file]),[role=button]")) { if (!shown(e) || e.disabled) continue; const r = e.getBoundingClientRect(); if (r.height < 43.5 || r.width < 43.5) { if (e.tagName === "A" && getComputedStyle(e).display === "inline" && r.height >= 40) continue; smallTargets.push(`${e.id ? "#" + e.id : e.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 20)}"`); } }
    const f = { smallText: smallText.slice(0, 6), smallTargets: smallTargets.slice(0, 6), sideways: document.documentElement.scrollWidth > W + 1, scale: visualViewport.scale, font: getComputedStyle(document.body).fontSize, beyond: [], spill: [], widths: {} };
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el)) continue; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if ((r.right > W + 1 || r.left < -1) && !clipped(el)) f.beyond.push(`${label(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
      if (el.children.length === 0 && el.textContent && el.textContent.trim() && cs.overflowX === "visible" && el.scrollWidth > el.clientWidth + 2) f.spill.push(`${label(el)} "${el.textContent.trim().slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
    }
    for (const sel of columns) { const el = document.querySelector(sel); if (el && vis(el)) f.widths[sel] = Math.round(el.getBoundingClientRect().width); }
    return f;
  }, columns);
}

/** Turn an audit into pass/fail lines through the test's own `check(ok, msg)`. `opts.baseFont` pins the font across states; `opts.ignoreWidths` names columns allowed to differ. */
export function judge(f, tag, check, opts = {}) {
  const ws = Object.entries(f.widths).filter(([k]) => !(opts.ignoreWidths ?? []).includes(k)).map(([, v]) => v);
  const uniform = ws.length ? Math.max(...ws) - Math.min(...ws) <= (opts.tolerance ?? 2) : true;
  check(!f.sideways && f.beyond.length === 0, `${tag}: nothing wider than the screen${f.beyond.length ? " → " + f.beyond.slice(0, 4).join(" | ") : ""}${f.sideways ? " (page scrolls sideways)" : ""}`);
  check(f.spill.length === 0, `${tag}: no text spilling out of its box${f.spill.length ? " → " + f.spill.slice(0, 4).join(" | ") : ""}`);
  check(uniform, `${tag}: one column width ${JSON.stringify(f.widths)}`);
  check(f.smallText.length === 0, `${tag}: no text under 15 px (${f.smallText.join("; ") || "none"})`);
  check(f.smallTargets.length === 0, `${tag}: no control under 44 px (${f.smallTargets.join("; ") || "none"})`);
  check(f.scale === 1 && (!opts.baseFont || f.font === opts.baseFont), `${tag}: scale ${f.scale}, base font ${f.font}`);
}
