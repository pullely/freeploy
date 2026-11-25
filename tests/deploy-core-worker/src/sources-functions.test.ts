// The pieces of Git sources and webhooks (DP-72), each held to what Coolify's own PHP returned for the same
// arguments (fixtures/sources: cases.json → emit.php → goldens.json): the GitHub App's JWT (byte for byte, and
// verified by the system `openssl` against the key's public half), the GitHub URL helpers, the webhook payload
// readers, the pull request reader, the watch path matcher, hash_hmac / hash_equals, the branch order, the
// repository slug — and the requests ApplicationPullRequestUpdateJob and SyncGithubDeploymentJob send.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubAppJwt, GithubKeyError } from "@deploy-core-worker/sources/jwt";
import {
  githubApiUrlFromHtmlUrl,
  githubAppInstallationUrl,
  githubAppPermissionsUrl,
  githubAppSettingsUrl,
  normalizeGithubOrganization,
  sortBranchesByPriority,
} from "@deploy-core-worker/sources/github";
import * as payload from "@deploy-core-worker/sources/webhook-payload";
import { hashEquals, hmacSha256Hex } from "@deploy-core-worker/sources/signatures";
import {
  gitRepositorySlug,
  githubDeploymentCreateRequest,
  githubDeploymentEnvironmentUrl,
  githubDeploymentRef,
  githubDeploymentState,
  githubDeploymentStatusRequest,
  pullRequestUpdateRequest,
  type ProcessStatus,
} from "@deploy-core-worker/sources/pr-updates";
import { fnCases, sourceCases, sourceGoldens, type Json } from "./source-goldens";

const golden = (id: string) => sourceGoldens.functions[id]!;
/** The message of a golden exception, without its class. */
const goldenError = (id: string): string => {
  const g = golden(id);
  if (g.ok) throw new Error(`${id} did not throw in PHP`);
  return g.error.slice(g.error.indexOf(": ") + 2);
};

/** Run a port: its value, or the message it threw. */
async function outcome(fn: () => unknown): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function expectGolden(id: string, fn: () => unknown, map: (v: unknown) => unknown = (v) => v): Promise<void> {
  const got = await outcome(fn);
  const g = golden(id);
  if (g.ok) {
    expect(got.ok ? "returned" : (got as { message: string }).message).toBe("returned");
    expect(map((got as { value: unknown }).value)).toEqual(g.value);
  } else if (goldenError(id).startsWith("preg_match(): Compilation failed")) {
    // PCRE's own wording of the compile error is not reproduced; that it fails is.
    expect(got).toEqual({ ok: false, message: "preg_match(): Compilation failed" });
  } else {
    expect(got).toEqual({ ok: false, message: goldenError(id) });
  }
}

describe("generateGithubAppJwt()", () => {
  it.each(fnCases("jwt.").filter(([id]) => id !== "jwt.openssh-key"))("%s is the same token, byte for byte", async (id, c) => {
    const a = c.args as { privateKey: string; appId: string | number; now: string };
    const token = await githubAppJwt(a.privateKey, a.appId, new Date(`${a.now.replace(" ", "T")}Z`));
    expect(token).toBe((golden(id) as { value: string }).value);
  });

  it("a PKCS#1 key and the same key as PKCS#8 sign alike", () => {
    expect((golden("jwt.pkcs1") as { value: string }).value).toBe((golden("jwt.pkcs8") as { value: string }).value);
  });

  it("refuses an OpenSSH key in lcobucci's words, which Coolify's pages recognize", async () => {
    expect(golden("jwt.openssh-key").ok).toBe(false);
    const c = sourceCases.functions.find((f) => f.id === "jwt.openssh-key")!;
    await expect(githubAppJwt(String(c.args.privateKey), 1)).rejects.toThrow(GithubKeyError);
    await expect(githubAppJwt(String(c.args.privateKey), 1)).rejects.toThrow(/parse your key/);
    expect(goldenError("jwt.openssh-key")).toMatch(/parse your key|DECODER routines::unsupported/);
  });

  const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
  (hasOpenssl ? it : it.skip)("openssl verifies the RS256 signature with the key's public half", async () => {
    const c = sourceCases.functions.find((f) => f.id === "jwt.pkcs1")!;
    const token = await githubAppJwt(String(c.args.privateKey), 123456, new Date("2026-11-20T10:11:12Z"));
    const [header, body, signature] = token.split(".");
    const dir = mkdtempSync(join(tmpdir(), "dp72-jwt-"));
    writeFileSync(join(dir, "key.pem"), String(c.args.privateKey));
    writeFileSync(join(dir, "data"), `${header}.${body}`);
    writeFileSync(join(dir, "sig"), Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    execFileSync("openssl", ["rsa", "-in", join(dir, "key.pem"), "-pubout", "-out", join(dir, "pub.pem")], { stdio: "ignore" });
    const verified = execFileSync("openssl", ["dgst", "-sha256", "-verify", join(dir, "pub.pem"), "-signature", join(dir, "sig"), join(dir, "data")]).toString();
    expect(verified.trim()).toBe("Verified OK");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ iss: "123456", iat: 1795169412, exp: 1795169952 });
  });
});

describe("the GitHub URL helpers", () => {
  it.each(fnCases("apiUrl."))("githubApiUrlFromHtmlUrl %s", async (id, c) => expectGolden(id, () => githubApiUrlFromHtmlUrl(String(c.args.htmlUrl))));
  it.each(fnCases("organization."))("normalizeGithubOrganization %s", async (id, c) => expectGolden(id, () => normalizeGithubOrganization(c.args.value as string | null)));
  it.each(fnCases("appUrls."))("settingsUrl, getPermissionsPath and getInstallationPath %s", async (id, c) => {
    const app = { name: String(c.args.name), organization: c.args.organization as string | null, html_url: String(c.args.html_url) };
    await expectGolden(id, () => ({
      settingsUrl: githubAppSettingsUrl(app),
      permissionsUrl: githubAppPermissionsUrl(app),
      installationUrl: githubAppInstallationUrl(app, "STATE").replace(/state=STATE$/, "state=<state>"),
    }));
  });
});

describe("the webhook payload readers", () => {
  const readers: Record<string, (...args: never[]) => unknown> = {
    webhookPushBranch: payload.webhookPushBranch,
    webhookPayloadString: payload.webhookPayloadString,
    webhookPayloadDatabaseId: payload.webhookPayloadDatabaseId,
    webhookCommitSha: payload.webhookCommitSha,
    webhookPayloadUrl: payload.webhookPayloadUrl,
    webhookPushChangedFiles: payload.webhookPushChangedFiles,
    webhookPushCommitMessages: payload.webhookPushCommitMessages,
    isWebhookBranchDeletionPush: payload.isWebhookBranchDeletionPush,
    shouldSkipDeploy: payload.shouldSkipDeploy,
    shouldSkipDeployAny: payload.shouldSkipDeployAny,
    manualWebhookRepositoryFullName: payload.manualWebhookRepositoryFullName,
    manualWebhookRepositoryMatches: payload.manualWebhookRepositoryMatches,
  };
  const readerCases = sourceCases.functions.filter((c) => c.fn === "reader").map((c) => [c.id, c] as const);
  it.each(readerCases)("%s", async (id, c) => {
    const args = c.args as { method: string; arguments: unknown[] };
    const reader = readers[args.method];
    expect(reader).toBeDefined();
    await expectGolden(id, () => (reader as (...a: unknown[]) => unknown)(...args.arguments));
  });
});

/** readPullRequestPayload()'s keys as PHP names them. */
const snakePr = (v: unknown) => {
  const p = v as payload.PullRequestPayload;
  return {
    action: p.action,
    pull_request_id: p.pullRequestId,
    pull_request_html_url: p.pullRequestHtmlUrl,
    pull_request_title: p.pullRequestTitle,
    branch: p.branch,
    base_branch: p.baseBranch,
    before_sha: p.beforeSha,
    after_sha: p.afterSha,
    commit_sha: p.commitSha,
    is_fork_pull_request: p.isForkPullRequest,
  };
};

describe("Github::readPullRequestPayload() and isForkPullRequest()", () => {
  it.each(fnCases("readPullRequest."))("%s", async (id, c) => expectGolden(id, () => payload.readGithubPullRequestPayload(c.args.payload), snakePr));
  it.each(fnCases("isFork."))("%s", async (id, c) => expectGolden(id, () => payload.isForkPullRequest(c.args.payload)));
});

describe("Application::matchPaths() (watch paths)", () => {
  it.each(fnCases("matchPaths."))("%s", async (id, c) => expectGolden(id, () => payload.matchWatchPaths(c.args.files as string[], c.args.watchPaths as string[])));
});

describe("hash_hmac('sha256') and hash_equals()", () => {
  it.each(fnCases("hmac."))("%s", async (id, c) => expectGolden(id, () => hmacSha256Hex(String(c.args.key), String(c.args.data))));
  it.each(fnCases("hashEquals."))("%s", async (id, c) => expectGolden(id, () => hashEquals(String(c.args.known), String(c.args.user))));
});

describe("sortBranchesByPriority() and gitRepositorySlug()", () => {
  it.each(fnCases("branches."))("%s", async (id, c) => expectGolden(id, () => sortBranchesByPriority(c.args.branches as Array<{ name: string }>).map((b) => b.name)));
  it.each(fnCases("slug."))("%s", async (id, c) => expectGolden(id, () => gitRepositorySlug(c.args.value as string | null)));
});

// ── The requests to GitHub ──────────────────────────────────────────────────────────────────────────────

/** Coolify's prose names Coolify; Freeploy's names Freeploy (the comment's and the deployment's text). */
const brand = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/Coolify/g, "Freeploy"));
const API = "https://api.github.com";
const BASE = "https://app.example.test";
/** The requests of a golden after the installation token: what the builder makes. */
const builtRequests = (requests: Array<{ method: string; url: string; body?: unknown }>) =>
  requests.filter((r) => !r.url.endsWith("/access_tokens")).map((r) => ({ method: r.method.toLowerCase(), url: r.url, ...(r.body === undefined ? {} : { body: r.body }) }));
const asSent = (r: { method: string; endpoint: string; data: Record<string, unknown> | null } | null) =>
  r === null ? [] : [{ method: r.method, url: `${API}/${r.endpoint.replace(/^\/+/, "")}`, ...(r.data === null ? {} : { body: r.data }) }];

describe("ApplicationPullRequestUpdateJob: the comment of a preview", () => {
  it.each(sourceCases.prUpdates.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const app = c.setup.applications[0]!;
    const g = sourceGoldens.prUpdates[id]!;
    const input = {
      status: c.status as ProcessStatus,
      applicationName: String(app.name),
      applicationUuid: "app0000000000000000000001",
      projectUuid: "prj0000000000000000000001",
      environmentUuid: "env0000000000000000000001",
      deploymentUuid: c.deploymentUuid,
      buildPack: String(app.build_pack ?? "nixpacks"),
      previewFqdn: (c.preview.fqdn as string | null | undefined) ?? null,
      previewDockerComposeDomains: (c.preview.docker_compose_domains as string | undefined) ?? null,
      baseUrl: BASE,
      now: "2026-11-20 10:11:12",
      isPublicRepository: app.source === "public",
      gitRepository: String(app.git_repository),
      pullRequestId: Number(c.preview.pull_request_id),
      issueCommentId: (c.preview.pull_request_issue_comment_id as string | undefined) ?? null,
    };
    const sent = builtRequests(g.requests);
    // The first request is the builder's; a comment GitHub no longer has (404 on PATCH) is created again.
    expect(asSent(pullRequestUpdateRequest(input))).toEqual(brand(sent.slice(0, 1)));
    if (sent.length > 1) expect(asSent(pullRequestUpdateRequest({ ...input, issueCommentId: null }))).toEqual(brand(sent.slice(1)));
  });
});

describe("SyncGithubDeploymentJob: the GitHub Deployment and its statuses", () => {
  it.each(sourceCases.deploymentSyncs.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const g = sourceGoldens.deploymentSyncs[id]!;
    const app = c.setup.applications[0]!;
    const d = c.deployment as Json & { status: string; commit: string; pull_request_id: number; github_deployment_id?: number; github_deployment_state?: string; horizon_job_worker?: string };
    const canSync = (c.setup.githubApp?.deployments ?? null) === "write";
    const sent: Array<{ method: string; url: string; body?: unknown }> = [];
    // handle(), in its order, with the builders for each request.
    const run = (): { id: number | null; state: string | null } => {
      let state = d.github_deployment_state ?? null;
      let ghId = d.github_deployment_id ?? null;
      if (!canSync || state === "inactive") return { id: ghId, state };
      const next = c.deactivate ? "inactive" : githubDeploymentState(d.status);
      if (next === null || next === state) return { id: ghId, state };
      if (!ghId) {
        if (next === "inactive") return { id: ghId, state: "inactive" };
        if (next === "error" || (next === "failure" && !d.horizon_job_worker)) return { id: ghId, state };
        let pullRequest: unknown = null;
        if (d.pull_request_id !== 0) {
          const answer = c.github.find((a) => new RegExp(a.match).test(`GET ${API}/repos/acme/app/pulls/${d.pull_request_id}`));
          pullRequest = answer?.body ?? null;
          sent.push({ method: "get", url: `${API}/repos/acme/app/pulls/${d.pull_request_id}` });
        }
        const ref = githubDeploymentRef({ commit: d.commit, pullRequestId: d.pull_request_id, gitBranch: String(app.git_branch), repositorySlug: "acme/app", pullRequest });
        sent.push(...asSent(githubDeploymentCreateRequest({ gitRepository: String(app.git_repository), applicationName: String(app.name), pullRequestId: d.pull_request_id, ref })));
        ghId = 555;
      }
      const preview = (c.previews ?? [])[0];
      const environmentUrl = githubDeploymentEnvironmentUrl({ buildPack: "nixpacks", fqdn: d.pull_request_id !== 0 ? ((preview?.fqdn as string | undefined) ?? null) : String(app.fqdn), dockerComposeDomains: null });
      sent.push(
        ...asSent(
          githubDeploymentStatusRequest({
            gitRepository: String(app.git_repository),
            githubDeploymentId: ghId,
            state: next,
            logUrl: `${BASE}/project/prj0000000000000000000001/environment/env0000000000000000000001/application/app0000000000000000000001/deployment/dep0000000000000000000001`,
            environmentUrl,
          }),
        ),
      );
      state = next;
      return { id: ghId, state };
    };
    const result = run();
    expect(sent).toEqual(brand(builtRequests(g.requests)));
    expect(result).toEqual({ id: g.github_deployment_id, state: g.github_deployment_state });
  });
});
