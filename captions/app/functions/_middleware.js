// Pages Function: one project, three hosts. smaverk.com is Maindesk's page (home.html), video.smaverk.com is the video
// tools' page (studio.html), captions.smaverk.com is the Captions tool. Only the paths in dist/_routes.json come here;
// every other path is served straight from static assets.
// A, 27 Oct 2026: smaverk.com leads with Maindesk and the video tools moved to video.smaverk.com, so the studio's old
// address on smaverk.com sends visitors on to the tools' new home.
const STUDIO_HOSTS = new Set(["smaverk.com", "www.smaverk.com"]);
const VIDEO_HOSTS = new Set(["video.smaverk.com"]);
const page = (env, request, url, path) => { url.pathname = path; return env.ASSETS.fetch(new Request(url, request)); };
export const onRequest = async ({ request, next, env }) => {
  const url = new URL(request.url);
  if (STUDIO_HOSTS.has(url.hostname)) {
    if (url.pathname === "/") return page(env, request, url, "/home");
    if (url.pathname === "/sitemap.xml") return page(env, request, url, "/studio-sitemap.xml");
    if (url.pathname === "/studio" || url.pathname === "/studio.html") return Response.redirect(`https://video.smaverk.com/${url.search}`, 301);
  }
  if (VIDEO_HOSTS.has(url.hostname)) {
    if (url.pathname === "/") return page(env, request, url, "/studio");
    if (url.pathname === "/sitemap.xml") return page(env, request, url, "/video-sitemap.xml");
    if (url.pathname === "/home" || url.pathname === "/home.html") return Response.redirect(`https://smaverk.com/${url.search}`, 301);
  }
  return next();
};
