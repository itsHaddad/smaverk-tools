// Pages Function: one project, two hosts. smaverk.com is the studio page; captions.smaverk.com is the Captions tool.
// Only "/" and the studio's sitemap are routed here (dist/_routes.json); every other path is served straight from static assets.
const STUDIO_HOSTS = new Set(["smaverk.com", "www.smaverk.com"]);
export const onRequest = async ({ request, next, env }) => {
  const url = new URL(request.url);
  if (STUDIO_HOSTS.has(url.hostname)) {
    if (url.pathname === "/") { url.pathname = "/studio"; return env.ASSETS.fetch(new Request(url, request)); }
    if (url.pathname === "/sitemap.xml") { url.pathname = "/studio-sitemap.xml"; return env.ASSETS.fetch(new Request(url, request)); }
  }
  return next();
};
