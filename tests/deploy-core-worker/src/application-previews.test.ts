// The console's Preview Deployments page (DP-99): Coolify's Previews, Preview\Form and PreviewDomains as console routes
// over the API fixture's previews in Freeploy's database (PGlite with every deploy migration, row-level security on) —
// Coolify's rules and messages, GitHub's pull requests asked as Coolify asks (through a fake fetch), what is stored,
// what runs on the server answered as not available yet with nothing stored, who may change the page, and one org
// never reaching another's previews.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleApplicationPreviews, isApplicationPreviewRoute, type PreviewPagesRunner } from "@deploy-core-worker/handlers/application-previews";
import type { SourceHttp } from "@deploy-core-worker/sources/github";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const IMAGE = "a1parityimageapp00000001";
const GIT = "a2paritygitapp0000000002";
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details?: { fields?: Record<string, string[]> } } };

function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean } = {}, github: (url: string) => Response = () => json([])) {
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  const http: SourceHttp = { fetch: async (url) => (asked.push(url), github(url)), sleep: async () => undefined };
  const runner: PreviewPagesRunner = (_env, orgId, fn) => withOrg(db, orgId, fn);
  const call = async (method: string, app: string, path: string, body?: unknown, org = ORG1) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const full = `${app}/previews${path ? `/${path}` : ""}`;
    const res = await handleApplicationPreviews(env, "req_1", actor, org, full.split("/"), new Request(`https://x/${full}`, init), runner, http);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { asked, call };
}

const previews = (db: TransactionalSqlExecutor, app: string, org = ORG1) =>
  withOrg(db, org, async (tx) => (await tx.execute<{ pull_request_id: number; fqdn: string | null; docker_registry_image_tag: string | null; deleted: boolean }>("SELECT p.pull_request_id, p.fqdn, p.docker_registry_image_tag, p.deleted_at IS NOT NULL AS deleted FROM deploy.application_previews p JOIN deploy.applications a ON a.id = p.application_id WHERE a.uuid = $1 ORDER BY p.id", [app])).rows);

describe("the page", () => {
  it("routes …/previews and lists a Git application's previews, newest pull request first, with their domains", async () => {
    expect([isApplicationPreviewRoute([GIT, "previews"]), isApplicationPreviewRoute([GIT, "backups"])]).toEqual([true, false]);
    await fixture.inCase(async (db) => {
      const r = await client(db).call("GET", GIT, "");
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ application: { uuid: GIT }, gitBased: true, isGithubAppSource: true, buildPack: "nixpacks", isPreviewDeploymentsEnabled: false, previewUrlTemplate: "{{pr_id}}.{{domain}}", generatedPattern: "{{pr_id}}.{{domain}}", previewServerName: null, canUpdate: true });
      const list = r.body.data!.previews as Array<Record<string, unknown>>;
      expect(list.map((p) => p.pullRequestId)).toEqual([17, 12]);
      expect(list[1]!.domains).toEqual([{ url: "https://pr-12.example.com", internalPort: 8080, hasPortOverride: true, dnsStatus: "pending", dnsMessage: "DNS has not been checked yet.", checkId: null }]);
      const image = await client(db).call("GET", IMAGE, "");
      expect(image.body.data).toMatchObject({ gitBased: false, isGithubAppSource: false, generatedPattern: "{{pr_id}}.image.example.com", previews: [{ pullRequestId: 3, dockerRegistryImageTag: "pr-3", status: "running:healthy" }] });
    });
  });

  it("saves the preview settings and the URL template with Coolify's messages", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("PATCH", GIT, "settings", { toggle: true })).body.data).toEqual({ message: "Settings saved.", isPreviewDeploymentsEnabled: true, isPrDeploymentsPublicEnabled: false });
      expect((await c.call("PATCH", GIT, "settings", { isPrDeploymentsPublicEnabled: true })).body.data).toMatchObject({ isPreviewDeploymentsEnabled: true, isPrDeploymentsPublicEnabled: true });
      expect((await c.call("PATCH", GIT, "settings", { isPrDeploymentsPublicEnabled: "x" })).body.error!.details!.fields).toEqual({ isPrDeploymentsPublicEnabled: ["The is pr deployments public enabled field must be true or false."] });
      expect((await c.call("GET", GIT, "")).body.data).toMatchObject({ isPreviewDeploymentsEnabled: true, isPrDeploymentsPublicEnabled: true });
      expect((await c.call("PATCH", IMAGE, "template", { previewUrlTemplate: " " })).body.error!.details!.fields).toEqual({ previewUrlTemplate: ["The preview url template field is required."] });
      expect((await c.call("PATCH", IMAGE, "template", { previewUrlTemplate: "pr-{{pr_id}} .{{domain}}" })).body.data).toEqual({ message: "Preview url template updated.", previewUrlTemplate: "pr-{{pr_id}}.{{domain}}", generatedPattern: "pr-{{pr_id}}.image.example.com" });
      expect((await c.call("PATCH", IMAGE, "template", { reset: true })).body.data).toMatchObject({ previewUrlTemplate: "{{pr_id}}.{{domain}}" });
    });
  });
});

describe("GitHub's pull requests (load_prs)", () => {
  it("asks GitHub for the repository's pulls as the public source, sorted by number", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, {}, () => json([{ number: 9, title: "Nine", html_url: "https://github.com/coollabsio/coolify-examples/pull/9" }, { number: 2, title: "Two", html_url: "https://github.com/coollabsio/coolify-examples/pull/2" }], 200, { "X-RateLimit-Remaining": "57" }));
      const r = await c.call("POST", GIT, "pull-requests");
      expect(r.body.data).toEqual({ rateLimitRemaining: 57, pullRequests: [{ number: 2, title: "Two", htmlUrl: "https://github.com/coollabsio/coolify-examples/pull/2" }, { number: 9, title: "Nine", htmlUrl: "https://github.com/coollabsio/coolify-examples/pull/9" }] });
      expect(c.asked).toEqual(["https://api.github.com/repos/coollabsio/coolify-examples/pulls"]);
    });
  });

  it("answers GitHub's refusal with Coolify's message, and an application without a GitHub App source with its own", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, {}, () => json({ message: "Not Found" }, 404, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "0" }));
      const refused = await c.call("POST", GIT, "pull-requests");
      expect(refused.body.error!.message).toBe(["GitHub API call failed:", "Error: Not Found", "Rate Limit Status:", "- Remaining Calls: 0", "- Reset Time: 1970-01-01 00:00:00 UTC"].join("\n"));
      expect((await c.call("POST", IMAGE, "pull-requests")).body.error!.message).toBe("Loading pull requests is only supported for GitHub App sources.");
    });
  });
});

describe("adding and deploying previews", () => {
  it("configures a pull request (add) with its generated domain; deploying it needs the SSH executor and stores nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const url = "https://github.com/coollabsio/coolify-examples/pull/99";
      expect((await c.call("POST", GIT, "", { pullRequestId: 99, pullRequestHtmlUrl: "ftp://x" })).body.error!.details!.fields).toEqual({ pull_request_html_url: ["The pull request html url field must be a valid URL."] });
      const deployed = await c.call("POST", GIT, "", { pullRequestId: 99, pullRequestHtmlUrl: url, deploy: true });
      expect([deployed.status, deployed.body.error!.message]).toEqual([501, UNAVAILABLE("Deploying the preview")]);
      expect((await previews(db, GIT)).map((p) => p.pull_request_id)).toEqual([17, 12]);
      const added = await c.call("POST", GIT, "", { pullRequestId: 99, pullRequestHtmlUrl: url });
      expect([added.status, added.body.data!.message]).toEqual([201, "Preview added."]);
      // The application has no domain: generateUrl() of the server (sslip) with the application's uuid, through the template.
      expect((await previews(db, GIT)).find((p) => p.pull_request_id === 99)!.fqdn).toBe("http://99.a2paritygitapp0000000002.203.0.113.10.sslip.io");
      // Configured again, its domain is kept.
      await c.call("POST", GIT, "", { pullRequestId: 99, pullRequestHtmlUrl: url });
      expect((await previews(db, GIT)).filter((p) => p.pull_request_id === 99).length).toBe(1);
      expect((await c.call("POST", GIT, "", { pullRequestId: 5 })).body.error!.message).toBe("Call to a member function generate_preview_fqdn() on null");
    });
  });

  it("holds the manual Docker image preview to its rules, then needs the SSH executor to deploy it", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const manual = (body: Record<string, unknown>, app = IMAGE) => c.call("POST", app, "", { manual: true, ...body });
      expect((await manual({ manualPullRequestId: "x", manualDockerTag: "v1" })).body.error!.details!.fields).toEqual({ manualPullRequestId: ["The manual pull request id field must be an integer."] });
      expect((await manual({ manualPullRequestId: 0, manualDockerTag: "v1" })).body.error!.details!.fields).toEqual({ manualPullRequestId: ["The manual pull request id field must be at least 1."] });
      expect((await manual({ manualPullRequestId: 4, manualDockerTag: "bad tag" })).body.error!.details!.fields).toEqual({ manualDockerTag: ["The manual docker tag field format is invalid."] });
      expect((await manual({ manualPullRequestId: 4, manualDockerTag: "v1" }, GIT)).body.error!.message).toBe("Manual Docker Image previews are only available for Docker Image applications.");
      expect((await manual({ manualPullRequestId: 4, manualDockerTag: " " })).body.error!.message).toBe("Both pull request id and docker tag are required.");
      const deployed = await manual({ manualPullRequestId: 4, manualDockerTag: " v1 " });
      expect([deployed.status, deployed.body.error!.message]).toEqual([501, UNAVAILABLE("Deploying the preview")]);
      expect((await previews(db, IMAGE)).map((p) => p.pull_request_id)).toEqual([3]);
    });
  });

  it("saves a preview's Docker tag, and answers deploying, redeploying and stopping as needing the SSH executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("PATCH", IMAGE, "1/docker-tag", { dockerTag: "bad tag" })).body.error!.details!.fields).toEqual({ "previewDockerTags.1": ["The docker tag field format is invalid."] });
      expect((await c.call("PATCH", IMAGE, "999/docker-tag", { dockerTag: "v2" })).body.error!.message).toBe("Preview not found");
      expect((await c.call("PATCH", IMAGE, "1/docker-tag", { dockerTag: "pr-3b" })).body.data).toEqual({ message: "Preview saved.\n\nDo not forget to redeploy the preview to apply the changes.", dockerRegistryImageTag: "pr-3b" });
      expect((await previews(db, IMAGE))[0]!.docker_registry_image_tag).toBe("pr-3b");
      for (const [path, what] of [["3/deploy", "Deploying the preview"], ["3/stop", "Stopping the preview"]] as const) {
        const r = await c.call("POST", IMAGE, path, { force: true });
        expect([path, r.status, r.body.error!.message]).toEqual([path, 501, UNAVAILABLE(what)]);
      }
    });
  });

  it("deletes a preview of a server that is not functional, and answers a functional one's cleanup as needing the SSH executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("DELETE", GIT, "77")).body.error!.message).toBe("Preview not found.");
      await withOrg(db, ORG1, (tx) => tx.execute("UPDATE deploy.server_settings SET is_reachable = true, is_usable = true"));
      const functional = await c.call("DELETE", GIT, "17");
      expect([functional.status, functional.body.error!.message]).toEqual([501, UNAVAILABLE("Removing the preview's containers from the server")]);
      await withOrg(db, ORG1, (tx) => tx.execute("UPDATE deploy.server_settings SET is_reachable = false"));
      expect((await c.call("DELETE", GIT, "17")).body.data!.message).toBe("Preview deletion started. It may take a few moments to complete.");
      expect((await previews(db, GIT)).map((p) => [p.pull_request_id, p.deleted])).toEqual([[17, true], [12, false]]);
    });
  });

  it("generates and removes a preview's domain (PreviewDomains)", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("DELETE", GIT, "3/domains/0")).body.data!.message).toBe("Domain removed.");
      expect((await previews(db, GIT)).find((p) => p.pull_request_id === 12)!.fqdn).toBeNull();
      const generated = await c.call("POST", GIT, "3/domains/generate");
      expect(generated.body.data!.message).toBe("Domain generated.");
      expect((await previews(db, GIT)).find((p) => p.pull_request_id === 12)!.fqdn).toBe("http://12.a2paritygitapp0000000002.203.0.113.10.sslip.io");
      await c.call("POST", IMAGE, "1/domains/generate");
      expect((await previews(db, IMAGE))[0]!.fqdn).toBe("https://3.image.example.com");
      expect((await c.call("POST", GIT, "999/domains/generate")).status).toBe(404);
    });
  });
});

describe("authorization and org isolation", () => {
  it("shows a member the page and refuses every change as a 404 that stores nothing", async () => {
    await fixture.inCase(async (db) => {
      const member = client(db, { write: false });
      expect((await member.call("GET", GIT, "")).body.data!.canUpdate).toBe(false);
      for (const [method, path, body] of [
        ["PATCH", "settings", { toggle: true }],
        ["PATCH", "template", { reset: true }],
        ["POST", "pull-requests", undefined],
        ["POST", "", { pullRequestId: 50, pullRequestHtmlUrl: "https://github.com/x/y/pull/50" }],
        ["DELETE", "17", undefined],
        ["POST", "3/domains/generate", undefined],
      ] as const) {
        expect([method, path, (await member.call(method, GIT, path, body)).status]).toEqual([method, path, 404]);
      }
      expect(member.asked).toEqual([]);
      expect((await previews(db, GIT)).map((p) => [p.pull_request_id, p.deleted])).toEqual([[17, false], [12, false]]);
      expect((await client(db, { read: false, write: false }).call("GET", GIT, "")).status).toBe(404);
    });
  });

  it("never reaches another org's application or preview", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("GET", GIT, "", undefined, ORG2)).status).toBe(404);
      expect((await c.call("DELETE", GIT, "17", undefined, ORG2)).status).toBe(404);
      expect((await c.call("DELETE", "a3otherteamapp0000000003", "17", undefined, ORG2)).body.error!.message).toBe("Preview not found.");
      expect((await previews(db, GIT)).every((p) => !p.deleted)).toBe(true);
    });
  });
});
