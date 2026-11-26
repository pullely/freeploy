// The Git webhook receivers (DP-72) replayed against Coolify's own controllers: every delivery of
// fixtures/sources (push, pull_request, ping, installation, workflow_job; good, bad and missing signatures;
// unknown events; malformed payloads; servers that are and are not functional) went through Coolify's
// Github::manual() / Github::normal() and the jobs they queue, and goes through Freeploy's receiver here, over
// an in-memory store built from the same rows. The answers must be the same — status, content type and body —
// as must the preview rows, the skipped deployments, and the requests sent to GitHub, with one mapping, the
// one thing Freeploy cannot do: where Coolify queued a deployment ("Deployment queued."), Freeploy answers that
// deploying needs the SSH executor, and no deployment row is stored. Coolify queues the cleanup of a closed pull
// request's preview (DeleteResourceJob); Freeploy removes the row at once when no deployment of the pull
// request was ever queued, and keeps it otherwise (stopping its containers needs the SSH executor).
import type { DeployApplicationPreviewRow, DeployGithubAppRow, DeployWebhookApplicationRow } from "@saas/db/deploy";
import { githubAppWebhook, githubManualWebhook, WEBHOOK_MESSAGES, type WebhookDeps, type WebhookOrgContext } from "@deploy-core-worker/sources/github-webhook";
import { manualWebhookRepositoryMatches } from "@deploy-core-worker/sources/webhook-payload";
import { InstallationTokens, type SourceHttp } from "@deploy-core-worker/sources/github";
import { handleGitWebhook, webhookResponse } from "@deploy-core-worker/handlers/git-webhooks";
import { sourceCases, sourceGoldens, SOURCE_NOW, type GithubAnswer, type Json, type WebhookCase } from "./source-goldens";

const ORG = "00000000-0000-4000-8000-000000000001";

interface World {
  deps: WebhookDeps;
  applications: DeployWebhookApplicationRow[];
  previews: DeployApplicationPreviewRow[];
  skipped: Array<Record<string, unknown>>;
  preexisting: Array<{ application_id: number; pull_request_id: number; status: string }>;
  requests: Array<{ method: string; url: string; body?: unknown }>;
}

function fakeHttp(answers: GithubAnswer[], requests: World["requests"]): SourceHttp {
  return {
    now: () => SOURCE_NOW,
    sleep: async () => undefined,
    fetch: async (url, init) => {
      requests.push({ method: init.method, url, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
      for (const a of answers) {
        if (new RegExp(a.match).test(`${init.method} ${url}`)) return new Response(JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: a.headers ?? {} });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    },
  };
}

/** The rows of a case as Freeploy stores them (one org), with Coolify's defaults for what the case leaves out. */
function world(c: WebhookCase): World {
  const requests: World["requests"] = [];
  const http = fakeHttp(c.github ?? [], requests);
  const s = c.setup;
  const servers = s.servers.map((server, i) => ({ id: i + 1, name: server.name, ip: server.ip ?? `10.0.0.${i + 2}`, functional: server.functional }));
  const appRow = s.githubApp
    ? ({ id: 1, uuid: "gha0000000000000000000001", name: String(s.githubApp.name), organization: null, api_url: "https://api.github.com", html_url: "https://github.com", app_id: Number(s.githubApp.app_id), installation_id: Number(s.githubApp.installation_id), webhook_secret: String(s.githubApp.webhook_secret), is_public: false, private_key_id: 2 } as unknown as DeployGithubAppRow)
    : null;
  const applications: DeployWebhookApplicationRow[] = s.applications.map((a: Json, i) => {
    const server = servers[Number(a.server ?? 0)]!;
    const settings = (a.settings ?? {}) as Json;
    return {
      id: i + 1,
      uuid: `app${String(i + 1).padStart(22, "0")}`,
      name: String(a.name),
      git_repository: (a.git_repository as string | null) ?? null,
      git_branch: String(a.git_branch ?? "main"),
      watch_paths: (a.watch_paths as string | undefined) ?? null,
      build_pack: String(a.build_pack ?? "nixpacks"),
      fqdn: (a.fqdn as string | undefined) ?? null,
      docker_compose_domains: null,
      preview_url_template: (a.preview_url_template as string | undefined) ?? "{{pr_id}}.{{domain}}",
      domain_port_overrides: null,
      repository_project_id: (a.repository_project_id as number | undefined) ?? null,
      source_id: a.source === "app" ? 1 : a.source === "public" ? 0 : null,
      source_type: a.source ? "App\\Models\\GithubApp" : null,
      manual_webhook_secret_github: (a.manual_webhook_secret_github as string | null | undefined) ?? null,
      manual_webhook_secret_gitlab: null,
      manual_webhook_secret_bitbucket: null,
      manual_webhook_secret_gitea: null,
      is_auto_deploy_enabled: settings.is_auto_deploy_enabled !== false,
      is_preview_deployments_enabled: settings.is_preview_deployments_enabled === true,
      is_pr_deployments_public_enabled: settings.is_pr_deployments_public_enabled === true,
      destination_id: server.id,
      server_id: server.id,
      server_name: server.name,
      server_ip: server.ip,
      server_wildcard_domain: null,
      server_is_reachable: server.functional,
      server_is_usable: server.functional,
      server_force_disabled: false,
      project_uuid: "prj0000000000000000000001",
      environment_uuid: "env0000000000000000000001",
    };
  });
  let previewId = 0;
  const previews: DeployApplicationPreviewRow[] = (s.previews ?? []).map((p: Json) => ({
    id: ++previewId,
    uuid: `prv${String(previewId).padStart(22, "0")}`,
    application_id: Number(p.application) + 1,
    pull_request_id: Number(p.pull_request_id),
    pull_request_html_url: String(p.pull_request_html_url),
    pull_request_issue_comment_id: null,
    fqdn: (p.fqdn as string | undefined) ?? null,
    status: "exited",
    git_type: null,
    docker_compose_domains: null,
    domain_port_overrides: null,
    is_same_repository: p.is_same_repository === true,
    created_at: null,
    updated_at: null,
  }));
  const preexisting = (s.deployments ?? []).map((d: Json) => ({ application_id: Number(d.application) + 1, pull_request_id: Number(d.pull_request_id ?? 0), status: String(d.status) }));
  const skipped: World["skipped"] = [];
  const ctx: WebhookOrgContext = {
    orgId: ORG,
    githubApp: async (id) => (appRow && Number(id) === 1 ? appRow : null),
    decrypt: async (_column, stored) => stored,
    applications: async (ids) => applications.filter((a) => ids.map(Number).includes(Number(a.id))),
    githubAppApplications: async (appId, repositoryProjectId, branch) =>
      applications.filter((a) => Number(a.source_id) === Number(appId) && a.source_type === "App\\Models\\GithubApp" && a.repository_project_id === repositoryProjectId && (branch === null || a.git_branch === branch)),
    credentials: async (app) => ({ name: app.name, organization: null, api_url: app.api_url, html_url: app.html_url, app_id: app.app_id, installation_id: app.installation_id, is_public: false, privateKey: String(s.githubApp!.privateKey) }),
    findPreview: async (applicationId, pullRequestId) => previews.find((p) => Number(p.application_id) === Number(applicationId) && p.pull_request_id === pullRequestId) ?? null,
    insertPreview: async (p) => {
      const row: DeployApplicationPreviewRow = { id: ++previewId, uuid: p.uuid, application_id: p.applicationId, pull_request_id: p.pullRequestId, pull_request_html_url: p.pullRequestHtmlUrl, pull_request_issue_comment_id: null, fqdn: null, status: "exited", git_type: p.gitType, docker_compose_domains: p.dockerComposeDomains, domain_port_overrides: null, is_same_repository: false, created_at: null, updated_at: null };
      previews.push(row);
      return row;
    },
    updatePreview: async (id, changes) => {
      Object.assign(previews.find((p) => p.id === id)!, changes);
    },
    previewHasDeployments: async (applicationId, pullRequestId) => preexisting.some((d) => d.application_id === Number(applicationId) && d.pull_request_id === pullRequestId && d.status !== "skipped"),
    deletePreview: async (id) => {
      const at = previews.findIndex((p) => p.id === id);
      if (at >= 0) previews.splice(at, 1);
      return at >= 0;
    },
    insertSkippedDeployment: async (d) => {
      skipped.push(d as unknown as Record<string, unknown>);
    },
    syncPermissions: async () => undefined,
  };
  const deps: WebhookDeps = {
    http,
    tokens: new InstallationTokens(http),
    now: () => SOURCE_NOW,
    githubAppTarget: async (appId, installationId) => {
      if (!appRow || appRow.app_id !== appId) return null;
      void installationId;
      return { org_id: ORG, id: 1 };
    },
    manualTargets: async (pattern, branches) => {
      const needle = pattern.slice(1, -1).replace(/\\_/g, "_");
      return applications.filter((a) => (a.git_repository ?? "").toLowerCase().includes(needle) && (branches === null || branches.includes(a.git_branch))).map((a) => ({ org_id: ORG, id: a.id }));
    },
    inOrg: async (_orgId, fn) => fn(ctx),
  };
  return { deps, applications, previews, skipped, preexisting, requests };
}

/** Coolify's answer with the one mapping: a queued deployment is Freeploy's "not available yet". */
function expectedBody(c: WebhookCase, body: string): string {
  if (!body.startsWith("[")) return body;
  const manual = c.path.endsWith("/manual");
  const payloads = JSON.parse(body) as Array<Record<string, unknown>>;
  return JSON.stringify(
    payloads.map((p) => {
      if (p.message !== "Deployment queued.") return p;
      return manual
        ? { application: p.application, status: "failed", message: WEBHOOK_MESSAGES.deployUnavailable, application_uuid: p.application_uuid, application_name: p.application_name }
        : { status: "failed", message: WEBHOOK_MESSAGES.deployUnavailable, application_uuid: p.application_uuid, application_name: p.application_name, deployment_uuid: null };
    }),
  );
}

/** A preview's random domain part (new_public_id()), numbered as the golden numbers it. */
function maskRandoms(value: string | null, seen: Map<string, string>): string | null {
  if (value === null) return null;
  return value.replace(/(?<![a-z0-9])[a-z0-9]{24}(?![a-z0-9])/g, (m) => {
    if (!seen.has(m)) seen.set(m, `<uuid:${seen.size + 1}>`);
    return seen.get(m)!;
  });
}

describe("the GitHub webhooks, replayed against Coolify's controllers", () => {
  it.each(sourceCases.webhooks.map((c) => [c.id, c] as const))("%s", async (id, c) => {
    const golden = sourceGoldens.webhooks[id]!;
    const w = world(c);
    const delivery = { headers: new Headers(c.headers), raw: c.body };
    const handled = c.path.endsWith("/manual") ? await githubManualWebhook(w.deps, delivery) : await githubAppWebhook(w.deps, delivery);
    for (const job of handled.after) await job();
    const response = webhookResponse(handled.answer);
    expect(response.status).toBe(golden.status);
    expect(response.headers.get("content-type")).toBe(golden.contentType);
    // Laravel's JSON escapes "/" — the answer's JSON is compared as data.
    const body = await response.text();
    if (golden.body.startsWith("[")) expect(JSON.parse(body)).toEqual(JSON.parse(expectedBody(c, golden.body)));
    else expect(body).toBe(golden.body);

    // The previews: what Coolify stored, less what its queued DeleteResourceJob removes when nothing was deployed.
    const deleteQueued = golden.jobs.some(([job]) => job === "App\\Jobs\\DeleteResourceJob");
    const expectedPreviews = golden.previews.filter((p) => {
      if (!deleteQueued) return true;
      return w.preexisting.some((d) => d.application_id === Number(p.application) + 1 && d.pull_request_id === p.pull_request_id && d.status !== "skipped");
    });
    const seen = new Map<string, string>();
    expect(
      w.previews.map((p) => ({
        application: Number(p.application_id) - 1,
        pull_request_id: p.pull_request_id,
        pull_request_html_url: p.pull_request_html_url,
        fqdn: maskRandoms(p.fqdn, seen),
        domain_port_overrides:
          p.domain_port_overrides === null ? null : Object.fromEntries(Object.entries(p.domain_port_overrides as Record<string, number>).map(([k, v]) => [maskRandoms(k, seen), v])),
        is_same_repository: p.is_same_repository,
      })),
    ).toEqual(
      expectedPreviews.map((p) => ({
        application: p.application,
        pull_request_id: p.pull_request_id,
        pull_request_html_url: p.pull_request_html_url,
        fqdn: p.fqdn,
        domain_port_overrides: p.domain_port_overrides,
        is_same_repository: p.is_same_repository,
      })),
    );

    // The deployment rows: the skipped ones as Coolify stores them; none that Coolify queued to run.
    const goldenSkipped = golden.deployments.filter((d) => d.status === "skipped");
    expect(w.skipped.map((d) => ({ commit_message: d.commitMessage, pull_request_id: d.pullRequestId, git_type: d.gitType, logs: (d.logs as Array<{ output: string }>).map((l) => l.output) }))).toEqual(
      goldenSkipped.map((d) => ({ commit_message: d.commit_message, pull_request_id: d.pull_request_id, git_type: d.git_type, logs: d.logs })),
    );

    // What was asked of GitHub (the installation tokens aside: Freeploy keeps one per delivery).
    const asked = (list: Array<{ method: string; url: string }>) => list.filter((r) => !r.url.endsWith("/access_tokens")).map((r) => `${r.method} ${r.url}`);
    expect(asked(w.requests)).toEqual(asked(golden.requests));
    expect(w.requests.some((r) => r.url.endsWith("/access_tokens"))).toBe(golden.requests.some((r) => r.url.endsWith("/access_tokens")));
  });
});

describe("the receiver's edges", () => {
  const manual = sourceCases.webhooks.find((c) => c.id === "manual.push.deploy")!;

  it("matches repositories as Coolify does", () => {
    expect(manualWebhookRepositoryMatches("https://github.com/Acme/App.git", "acme/app")).toBe(true);
    expect(manualWebhookRepositoryMatches("https://github.com/acme/app2", "acme/app")).toBe(false);
  });

  it("refuses a body over 25 MB before reading it", async () => {
    const request = new Request("https://deploy-core.internal/v1/internal/webhooks/source/github/events/manual", { method: "POST", headers: { "content-length": String(26 * 1024 * 1024) }, body: "x" });
    const response = await handleGitWebhook(request, { ENVIRONMENT: "test" }, "r1", "github", true, world(manual).deps);
    expect(response.status).toBe(413);
  });

  it("answers the receivers that are not ported with 501", async () => {
    for (const provider of ["gitlab", "gitea", "bitbucket"]) {
      const response = await handleGitWebhook(new Request("https://x/", { method: "POST", body: "{}" }), { ENVIRONMENT: "test" }, "r1", provider, true, world(manual).deps);
      expect(response.status).toBe(501);
    }
  });

  it("never throws on a body that is not JSON, and answers as Coolify does", async () => {
    const w = world(manual);
    for (const raw of ["", "{", "[]", "null", "\u0000\u0001", "x".repeat(10_000)]) {
      const handled = await githubManualWebhook(w.deps, { headers: new Headers({ ...manual.headers, "X-GitHub-Event": "push" }), raw });
      expect(handled.answer.body).toBe("Nothing to do. No branch found in the request.");
    }
  });

  it("checks the signature over the raw bytes: one changed byte is refused", async () => {
    const c = sourceCases.webhooks.find((x) => x.id === "manual.push.server-not-functional")!;
    const w = world(c);
    const ok = await githubManualWebhook(w.deps, { headers: new Headers(c.headers), raw: c.body });
    expect(JSON.stringify(ok.answer.body)).toContain("Server is not functional.");
    const tampered = await githubManualWebhook(w.deps, { headers: new Headers(c.headers), raw: c.body.replace('"Change"', '"Chang3"') });
    expect(tampered.answer.body).toEqual([{ status: "failed", message: "No matching application or invalid signature." }]);
  });

  it("refuses an App delivery signed with another secret, and one without a signature", async () => {
    const c = sourceCases.webhooks.find((x) => x.id === "app.push.deploy")!;
    for (const signature of ["sha256=" + "f".repeat(64), "", "sha1=abc"]) {
      const handled = await githubAppWebhook(world(c).deps, { headers: new Headers({ ...c.headers, "X-Hub-Signature-256": signature }), raw: c.body });
      expect(handled.answer.body).toBe("Invalid signature.");
    }
  });
});
