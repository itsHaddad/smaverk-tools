// remote.mjs: a browser that runs somewhere else. With PW_WS set (./ci.sh browser writes it to .ci/browser.env),
// Playwright connects to the server on a GitHub runner and nothing heavy runs on the laptop; without it, the browser
// launches here as before. The caller passes its own playwright import so versions match its package.json.
//   import { chromium } from "playwright"; import { openBrowser } from "../../../_tools/remote.mjs";
//   const browser = await openBrowser(chromium, { headless: false, args: ["--enable-unsafe-swiftshader"] });
// Files given to setInputFiles travel over the connection, so local fixtures work. The remote browser cannot see
// localhost on the laptop: point it at the live pages; local builds are tested by the gates workflow instead.
export async function openBrowser(browserType, launch = {}) {
  const ws = process.env.PW_WS;
  if (!ws) return browserType.launch(launch);
  return browserType.connect(ws, { timeout: 90_000, headers: { "x-playwright-launch-options": JSON.stringify(launch) } });
}
export const remote = () => Boolean(process.env.PW_WS);
