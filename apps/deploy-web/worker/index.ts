// deploy-web's Worker: serves the built SPA from Workers Static Assets.
// Every path that is not a file gets index.html (the SPA resolves Coolify's
// routes client-side), matching routes/web.php URLs one to one.
export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404 || request.method !== "GET") return res;
    const url = new URL(request.url);
    return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  },
} satisfies ExportedHandler<Env>;
