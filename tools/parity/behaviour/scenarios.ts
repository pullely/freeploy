// The behaviour scenarios. Each returns the normalised end state; the same
// scenario run on both systems must return equal states (compare.ts).
export interface Ctx {
  ids: Record<string, string>;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  docker: (argv: string[]) => string;
  sleep: (ms: number) => Promise<void>;
}
export interface Scenario { id: string; title: string; milestone: string; run: (ctx: Ctx) => Promise<unknown> }

/** Values that differ between any two systems or runs, replaced by stable tokens. */
export function normalise(value: unknown, ids: Record<string, string>): unknown {
  const swaps = Object.entries(ids).filter(([, v]) => v && v.length >= 6).sort((a, b) => b[1].length - a[1].length);
  const fix = (s: string) => {
    let out = s;
    for (const [k, v] of swaps) out = out.split(v).join(`<${k}>`);
    return out
      .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
      .replace(/\b[0-9a-f]{12}\b/g, "<shortid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, "<time>")
      .replace(/\b\d{6}T\d{6}\b|\b\d{8}T\d{6}\b/g, "<stamp>");
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [fix(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/** The comparable state of a resource's containers. */
export function containerState(ctx: Ctx, labelFilter: string) {
  const ids = ctx.docker(["ps", "-aq", "--filter", `label=${labelFilter}`]).split("\n").filter(Boolean);
  if (!ids.length) return [];
  const inspected = JSON.parse(ctx.docker(["inspect", ...ids]));
  return inspected
    .map((c: any) => ({
      name: c.Name,
      image: c.Config?.Image,
      state: c.State?.Status,
      restartPolicy: c.HostConfig?.RestartPolicy?.Name,
      labels: c.Config?.Labels ?? {},
      env: (c.Config?.Env ?? []).map((e: string) => e.split("=")[0]).sort(),
      networks: Object.keys(c.NetworkSettings?.Networks ?? {}).sort(),
      mounts: (c.Mounts ?? []).map((m: any) => ({ type: m.Type, destination: m.Destination, rw: m.RW })).sort((a: any, b: any) => a.destination.localeCompare(b.destination)),
      ports: c.HostConfig?.PortBindings ?? {},
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
}

async function waitDeployment(ctx: Ctx, uuid: string, minutes = 15) {
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    const { json } = await ctx.api("GET", `/deployments/${uuid}`);
    const status = json?.status;
    if (["finished", "failed", "cancelled-by-user", "skipped"].includes(status)) return status;
    if (Date.now() > until) throw new Error(`deployment ${uuid} still ${status} after ${minutes} minutes`);
    await ctx.sleep(5000);
  }
}

export const SCENARIOS: Scenario[] = [
  {
    id: "application.dockerimage.deploy",
    title: "Deploy the Docker-image application and read its container",
    milestone: "DP5",
    async run(ctx) {
      const app = ctx.ids.application_uuid;
      if (!app) throw new Error("no application fixture");
      const { status, json } = await ctx.api("POST", `/deploy?uuid=${app}&force=true`);
      if (status >= 400) throw new Error(`deploy → ${status} ${JSON.stringify(json).slice(0, 200)}`);
      const deployment = json?.deployments?.[0]?.deployment_uuid;
      if (!deployment) throw new Error(`no deployment uuid in ${JSON.stringify(json).slice(0, 200)}`);
      const final = await waitDeployment(ctx, deployment);
      if (final !== "finished") throw new Error(`deployment ended ${final}`);
      const { json: appJson } = await ctx.api("GET", `/applications/${app}`);
      return normalise({ deployment: final, applicationStatus: appJson?.status, containers: containerState(ctx, `coolify.applicationUuid=${app}`) }, { ...ctx.ids, deployment_uuid: deployment });
    },
  },
];
