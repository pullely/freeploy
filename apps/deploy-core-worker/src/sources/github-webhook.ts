// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Webhook/Github.php (manual, normal,
// handleWorkflowJob, githubPushComparedFiles), app/Http/Controllers/Webhook/Concerns/*.php,
// app/Jobs/ProcessGithubPullRequestWebhook.php, app/Actions/Application/CleanupPreviewDeployment.php,
// app/Models/ApplicationPreview.php (generate_preview_fqdn, generatedPreviewDomain, recordSameRepository),
// app/Models/{Application,Server}.php (isDeployable, isPRDeployable, isFunctional) and
// bootstrap/helpers/shared.php (handleError) (Apache-2.0), modified.
//
// GitHub's webhooks: /webhooks/source/github/events (a GitHub App's, signed with the App's webhook secret)
// and /webhooks/source/github/events/manual (a repository's own webhook, signed with the application's manual
// secret). The signature is checked as Coolify checks it — HMAC-SHA256 of the raw body, compared in constant
// time — before anything of the delivery is acted on, and the answers are Coolify's answers.
//
// Deploying is the one thing that cannot happen: a push to a deployable application would be queued with
// queue_application_deployment(), which needs the SSH executor (WAITING.md W3). Every Freeploy server is
// unreachable until that executor validates it, so Coolify's own answer — "Server is not functional." — is
// what a delivery gets today; a server that is marked functional gets Freeploy's "not available yet" in place
// of "Deployment queued.", and nothing is queued. A pull request is handed to ProcessGithubPullRequestWebhook
// (run in-line here, after the answer is made, as Coolify's queue runs it after its answer): its preview row
// is created as Coolify creates it, and its deployment is not queued.
import type { DeployApplicationPreviewRow, DeployGithubAppRow, DeployWebhookApplicationRow, NewSkippedDeployment, WebhookTarget } from "@saas/db/deploy";
import {
  dataGet,
  InvalidWebhookPayload,
  isWebhookBranchDeletionPush,
  manualWebhookRepositoryFullName,
  manualWebhookRepositoryMatches,
  manualWebhookRepositoryPattern,
  readGithubPullRequestPayload,
  shouldSkipDeploy,
  shouldSkipDeployAny,
  UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE,
  webhookCommitSha,
  webhookPayloadDatabaseId,
  webhookPushBranch,
  webhookPushChangedFiles,
  webhookPushCommitMessages,
  webhookPushMatchesWatchPaths,
  matchWatchPaths,
  type Payload,
  type PullRequestPayload,
} from "./webhook-payload.js";
import { githubCommitMessage, githubCommitRangeFiles, githubPullRequestFiles, type GithubAppCredentials, type InstallationTokens, type SourceHttp } from "./github.js";
import { hmacSha256Hex, hashEquals } from "./signatures.js";
import { newPublicId } from "../helpers/names.js";
import { parseUrl } from "../s3-storages/safe-url.js";

/** What a receiver answers: Laravel's response($content), a string (text/html) or a JSON value. */
export interface WebhookAnswer {
  status: number;
  body: string | unknown[] | Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The delivery as the receiver reads it. */
export interface WebhookDelivery {
  headers: Headers;
  /** The raw body, exactly as signed. */
  raw: string;
}

/** One org's rows, inside its withOrg() transaction. */
export interface WebhookOrgContext {
  orgId: string;
  githubApp(id: string | number): Promise<DeployGithubAppRow | null>;
  decrypt(column: string, stored: string): Promise<string>;
  applications(ids: Array<string | number>): Promise<DeployWebhookApplicationRow[]>;
  githubAppApplications(githubAppId: string | number, repositoryProjectId: number, branch: string | null): Promise<DeployWebhookApplicationRow[]>;
  credentials(app: DeployGithubAppRow): Promise<GithubAppCredentials>;
  findPreview(applicationId: string | number, pullRequestId: number): Promise<DeployApplicationPreviewRow | null>;
  insertPreview(preview: { uuid: string; applicationId: string | number; pullRequestId: number; pullRequestHtmlUrl: string; gitType: string; dockerComposeDomains: string | null }): Promise<DeployApplicationPreviewRow>;
  updatePreview(id: string | number, changes: { fqdn?: string | null; domain_port_overrides?: Record<string, number> | null; is_same_repository?: boolean }): Promise<void>;
  previewHasDeployments(applicationId: string | number, pullRequestId: number): Promise<boolean>;
  deletePreview(id: string | number): Promise<boolean>;
  insertSkippedDeployment(deployment: Omit<NewSkippedDeployment, "orgId">): Promise<void>;
  /** GithubAppPermissionJob, best effort. */
  syncPermissions(app: DeployGithubAppRow): Promise<void>;
}

export interface WebhookDeps {
  /** asPlatformAdmin(): which org's App this is. */
  githubAppTarget(appId: number, installationId: number | null): Promise<WebhookTarget | null>;
  /** asPlatformAdmin(): which orgs' applications a manual webhook may be for. */
  manualTargets(pattern: string, branches: string[] | null): Promise<WebhookTarget[]>;
  inOrg<T>(orgId: string, fn: (ctx: WebhookOrgContext) => Promise<T>): Promise<T>;
  http: SourceHttp;
  tokens: InstallationTokens;
  now: () => Date;
}

export const WEBHOOK_MESSAGES = {
  /** Freeploy's, in place of "Deployment queued.": queue_application_deployment() needs the SSH executor. */
  deployUnavailable: "Deploying the application needs the SSH executor, which is not available yet.",
} as const;

const text = (body: string, status = 200): WebhookAnswer => ({ status, body });
const json = (body: unknown[] | Record<string, unknown>, status = 200): WebhookAnswer => ({ status, body });

/** Server::isFunctional(): reachable, usable, not disabled, a real IP. */
export function serverIsFunctional(app: Pick<DeployWebhookApplicationRow, "server_id" | "server_is_reachable" | "server_is_usable" | "server_force_disabled" | "server_ip">): boolean {
  return (
    app.server_id !== null &&
    Boolean(app.server_is_reachable) &&
    Boolean(app.server_is_usable) &&
    app.server_force_disabled === false &&
    !(app.server_ip === null || app.server_ip.trim() === "" || ["1.2.3.4", "0.0.0.0", "::"].includes(app.server_ip))
  );
}

/** $applications->groupBy(fn ($app) => $app->destination->server_id), flattened: by server in order of first appearance. */
function byServer<T extends { server_id: string | number | null }>(applications: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const a of applications) {
    const key = String(a.server_id ?? "");
    const group = groups.get(key);
    if (group) group.push(a);
    else groups.set(key, [a]);
  }
  return [...groups.values()].flat();
}

/** Str::after($header, 'sha256='). */
const afterSha256 = (value: string | null): string => {
  const v = value ?? "";
  const at = v.indexOf("sha256=");
  return at === -1 ? v : v.slice(at + "sha256=".length);
};

/** $request->collect(): the JSON body for a JSON request, else the form fields. */
export function requestPayload(delivery: WebhookDelivery): Payload {
  const type = delivery.headers.get("content-type") ?? "";
  if (type.includes("/json") || type.includes("+json")) {
    try {
      const parsed: unknown = JSON.parse(delivery.raw);
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  const form: Record<string, string> = {};
  new URLSearchParams(delivery.raw).forEach((v, k) => (form[k] = v));
  return form;
}

// ── The PR job ─────────────────────────────────────────────────────────────────────────────────────────

export interface PullRequestJob {
  application: DeployWebhookApplicationRow;
  githubApp: DeployGithubAppRow | null;
  pr: PullRequestPayload;
  fullName: string;
}

const deploymentPath = (a: DeployWebhookApplicationRow, deploymentUuid: string): string => `/project/${a.project_uuid}/environment/${a.environment_uuid}/application/${a.uuid}/deployment/${deploymentUuid}`;

/** ProcessGithubPullRequestWebhook::recordSkippedDeployment(): a finished, skipped row with the reason. */
async function recordSkippedDeployment(ctx: WebhookOrgContext, deps: WebhookDeps, job: PullRequestJob, reason: string, details: string[] = []): Promise<void> {
  const uuid = newPublicId();
  const { application } = job;
  const timestamp = deps.now().toISOString().replace(/\.\d{3}Z$/, ".000000Z");
  await ctx.insertSkippedDeployment({
    applicationId: application.id,
    applicationName: application.name,
    deploymentUuid: uuid,
    deploymentUrl: deploymentPath(application, uuid),
    serverId: application.server_id,
    serverName: application.server_name,
    destinationId: application.destination_id,
    pullRequestId: job.pr.pullRequestId,
    commit: job.pr.commitSha,
    commitMessage: reason,
    gitType: "github",
    logs: [reason, ...details].map((line, i) => ({ command: null, output: line.trim(), type: "stdout", timestamp, hidden: false, batch: 1, order: i + 1 })),
  });
}

/** ApplicationPreview::generatedPreviewDomain(): the template with {{random}}, {{domain}} and {{pr_id}}, and the source's port. */
export function generatedPreviewDomain(sourceDomain: string, template: string | null, pullRequestId: number, overrides: Record<string, number> | null, random: string): { url: string; port: number | null } {
  const parsed = parseUrl(sourceDomain) ?? {};
  const host = parsed.host ?? "";
  let schema = parsed.scheme ?? "";
  const urlPath = parsed.path ?? "";
  const path = urlPath !== "" && urlPath !== "/" ? urlPath : "";
  let fqdn = (template ?? "{{pr_id}}.{{domain}}").split("{{random}}").join(random).split("{{domain}}").join(host).split("{{pr_id}}").join(String(pullRequestId));
  const m = /^(https?):\/\/(.*)$/is.exec(fqdn);
  if (m) {
    schema = m[1]!.toLowerCase();
    fqdn = m[2]!;
  }
  const canonical = parsed.port === undefined ? sourceDomain : sourceDomain.replace(`:${parsed.port}`, "");
  const port = parsed.port ?? overrides?.[canonical] ?? null;
  return { url: `${schema}://${fqdn}${path}`, port: port === null ? null : Math.trunc(Number(port)) };
}

/**
 * ProcessGithubPullRequestWebhook::handle(). Opened, synchronize and reopened: the skip markers, the fork
 * rule, the watch paths, then the preview row (created once, with generate_preview_fqdn()) and
 * recordSameRepository(); the deployment Coolify queues next needs the SSH executor and is not queued.
 * Closed: CleanupPreviewDeployment — nothing happens on a server that is not functional; on a functional one
 * the preview row goes when nothing of it can be on the server (no deployment of the pull request was ever
 * queued), as DeleteResourceJob would find nothing to stop; otherwise stopping it needs the SSH executor.
 */
export async function processGithubPullRequest(ctx: WebhookOrgContext, deps: WebhookDeps, job: PullRequestJob): Promise<void> {
  const { application, pr } = job;
  const githubApp = job.githubApp ? await ctx.credentials(job.githubApp) : null;
  if (pr.action === "closed" || pr.action === "close") {
    const found = await ctx.findPreview(application.id, pr.pullRequestId);
    if (!found) return;
    // ApplicationPullRequestUpdateJob(CLOSED) deletes the comment Coolify posted; Freeploy never posted one.
    if (!serverIsFunctional(application)) return;
    if (!(await ctx.previewHasDeployments(application.id, pr.pullRequestId))) await ctx.deletePreview(found.id);
    return;
  }
  if (!["opened", "synchronize", "reopened"].includes(pr.action)) return;
  if (!application.is_preview_deployments_enabled) return;
  const [owner = "", repo = ""] = job.fullName.split("/");
  const headCommitMessage = await githubCommitMessage(deps.http, deps.tokens, githubApp, owner, repo, pr.commitSha);
  if (shouldSkipDeployAny([pr.pullRequestTitle, headCommitMessage])) {
    await recordSkippedDeployment(ctx, deps, job, "Skipped the preview deployment: the pull request title or the head commit message contains a skip marker ([skip ci] or [skip cd]).");
    return;
  }
  if (pr.isForkPullRequest && !application.is_pr_deployments_public_enabled) {
    await recordSkippedDeployment(ctx, deps, job, "Skipped the preview deployment: the pull request comes from a fork and public PR deployments are disabled.");
    return;
  }
  let changedFiles: string[] | null = [];
  if (pr.action === "synchronize" && pr.beforeSha && pr.afterSha) changedFiles = await githubCommitRangeFiles(deps.http, deps.tokens, githubApp, owner, repo, pr.beforeSha, pr.afterSha);
  else if (pr.action === "opened" || pr.action === "reopened") changedFiles = await githubPullRequestFiles(deps.http, deps.tokens, githubApp, owner, repo, pr.pullRequestId);
  if (application.watch_paths !== null && application.watch_paths.trim() !== "" && changedFiles !== null) {
    const paths = application.watch_paths.split("\n");
    if (matchWatchPaths(changedFiles, paths).length === 0) {
      await recordSkippedDeployment(ctx, deps, job, "Skipped the preview deployment: no changed file matches the watch paths.", [
        `Watch paths: ${paths
          .map((p) => p.trim())
          .filter((p) => p !== "" && p !== "0")
          .join(", ")}`,
        `Changed files (${changedFiles.length}): ${changedFiles.slice(0, 50).join(", ")}${changedFiles.length > 50 ? ", ..." : ""}`,
      ]);
      return;
    }
  }
  let preview = await ctx.findPreview(application.id, pr.pullRequestId);
  if (!preview) {
    const compose = application.build_pack === "dockercompose";
    preview = await ctx.insertPreview({
      uuid: newPublicId(),
      applicationId: application.id,
      pullRequestId: pr.pullRequestId,
      pullRequestHtmlUrl: pr.pullRequestHtmlUrl,
      gitType: "github",
      dockerComposeDomains: compose ? application.docker_compose_domains : null,
    });
    // generate_preview_fqdn(); a Compose application's per-service domains wait for the Compose parser.
    if (!compose && application.fqdn !== null && application.fqdn !== "" && application.fqdn !== "0") {
      const source = application.fqdn.includes(",") ? application.fqdn.split(",")[0]! : application.fqdn;
      const overrides = application.domain_port_overrides !== null && typeof application.domain_port_overrides === "object" ? (application.domain_port_overrides as Record<string, number>) : null;
      const generated = generatedPreviewDomain(source, application.preview_url_template, pr.pullRequestId, overrides, newPublicId());
      await ctx.updatePreview(preview.id, { fqdn: generated.url, domain_port_overrides: generated.port !== null ? { [generated.url]: generated.port } : null });
    }
  }
  if (Boolean(preview.is_same_repository) !== !pr.isForkPullRequest) await ctx.updatePreview(preview.id, { is_same_repository: !pr.isForkPullRequest });
  // queue_application_deployment(pull_request_id: …, git_type: 'github'): needs the SSH executor.
}

// ── The receivers ───────────────────────────────────────────────────────────────────────────────────────

/** What the receiver hands to the PR job after it answered. */
export type AfterAnswer = () => Promise<void>;

interface Handled {
  answer: WebhookAnswer;
  after: AfterAnswer[];
}

/**
 * The deploy step of a push: what Coolify answers with queue_application_deployment()'s result, here the
 * "not available yet" of a deployment that cannot be queued.
 */
const pushUnavailable = (application: DeployWebhookApplicationRow, manual: boolean): Record<string, unknown> =>
  manual
    ? { application: application.name, status: "failed", message: WEBHOOK_MESSAGES.deployUnavailable, application_uuid: application.uuid, application_name: application.name }
    : { status: "failed", message: WEBHOOK_MESSAGES.deployUnavailable, application_uuid: application.uuid, application_name: application.name, deployment_uuid: null };

/** Github::manual(). */
export async function githubManualWebhook(deps: WebhookDeps, delivery: WebhookDelivery): Promise<Handled> {
  const after: AfterAnswer[] = [];
  try {
    const event = (delivery.headers.get("X-GitHub-Event") ?? "").toLowerCase();
    const signature = afterSha256(delivery.headers.get("X-Hub-Signature-256"));
    const contentType = delivery.headers.get("Content-Type");
    let payload: Payload = requestPayload(delivery);
    if (event === "ping") return { answer: text("pong"), after };
    if (contentType !== "application/json") {
      const form = dataGet(payload, "payload");
      if (typeof form === "string") {
        try {
          payload = JSON.parse(form) as Payload;
        } catch {
          payload = null;
        }
      } else payload = null;
    }
    let branch: string | null = null;
    let fullName: unknown = null;
    let commit: string | null = null;
    let changedFiles: string[] | null = null;
    let skip = false;
    let pr: PullRequestPayload | null = null;
    if (event === "push") {
      branch = webhookPushBranch(dataGet(payload, "ref"));
      fullName = dataGet(payload, "repository.full_name");
      commit = webhookCommitSha(payload, "after");
      changedFiles = webhookPushChangedFiles(payload);
      skip = shouldSkipDeploy(webhookPushCommitMessages(payload));
    }
    if (event === "pull_request") {
      pr = readGithubPullRequestPayload(payload);
      branch = pr.branch;
      fullName = dataGet(payload, "repository.full_name");
    }
    if (event !== "push" && event !== "pull_request") return { answer: text(`Nothing to do. Event '${event}' is not supported.`), after };
    if (!branch || (event === "pull_request" && pr!.action !== "closed" && !pr!.baseBranch)) return { answer: text("Nothing to do. No branch found in the request."), after };
    if (event === "push" && isWebhookBranchDeletionPush(payload)) return { answer: text("Nothing to do. Branch deleted."), after };
    const name = manualWebhookRepositoryFullName(fullName);
    if (name === null) return { answer: text("Nothing to do. Invalid repository."), after };
    const matchedBranch = event === "push" ? branch : pr!.action === "closed" ? null : pr!.baseBranch;
    const targets = await deps.manualTargets(manualWebhookRepositoryPattern(name), matchedBranch === null ? null : [matchedBranch]);
    // One withOrg() per org; the applications in Coolify's order (by id, then by server).
    const byOrg = new Map<string, Array<string | number>>();
    for (const t of targets) byOrg.set(t.org_id, [...(byOrg.get(t.org_id) ?? []), t.id]);
    const loaded: Array<{ orgId: string; app: DeployWebhookApplicationRow; secret: string | null }> = [];
    for (const [orgId, ids] of byOrg) {
      const rows = await deps.inOrg(orgId, async (ctx) =>
        Promise.all(
          (await ctx.applications(ids))
            .filter((a) => manualWebhookRepositoryMatches(a.git_repository, name))
            .map(async (app) => ({ orgId, app, secret: app.manual_webhook_secret_github ? await ctx.decrypt("applications.manual_webhook_secret_github", app.manual_webhook_secret_github) : null })),
        ),
      );
      loaded.push(...rows);
    }
    loaded.sort((a, b) => Number(a.app.id) - Number(b.app.id));
    if (loaded.length === 0) return { answer: json([{ ...UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE }]), after };
    const payloads: Array<Record<string, unknown>> = [];
    const failure = (): Record<string, unknown> => ({ ...UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE });
    for (const { orgId, app, secret } of byServer(loaded.map((l) => ({ ...l, server_id: l.app.server_id })))) {
      if (secret === null || secret === "") {
        payloads.push(failure());
        continue;
      }
      if (!hashEquals(signature, await hmacSha256Hex(secret, delivery.raw))) {
        payloads.push(failure());
        continue;
      }
      if (!serverIsFunctional(app)) {
        payloads.push({ application: app.name, status: "failed", message: "Server is not functional." });
        continue;
      }
      if (event === "push") {
        if (!app.is_auto_deploy_enabled) {
          payloads.push({ status: "failed", message: "Deployments disabled.", application_uuid: app.uuid, application_name: app.name });
        } else if (!webhookPushMatchesWatchPaths(app.watch_paths, changedFiles)) {
          payloads.push({
            status: "failed",
            message: "Changed files do not match watch paths. Ignoring deployment.",
            application_uuid: app.uuid,
            application_name: app.name,
            details: { changed_files: changedFiles, watch_paths: (app.watch_paths ?? "").split("\n") },
          });
        } else if (skip) {
          payloads.push({ application: app.name, status: "skipped", message: "All commits contain [skip cd] or [skip ci]. Skipping deployment.", application_uuid: app.uuid, application_name: app.name });
        } else {
          void commit;
          payloads.push(pushUnavailable(app, true));
        }
      }
      if (event === "pull_request") {
        if (!app.is_preview_deployments_enabled && pr!.action !== "closed") {
          payloads.push({ application: app.name, status: "failed", message: "Preview deployments disabled." });
          continue;
        }
        const job: PullRequestJob = { application: app, githubApp: null, pr: pr!, fullName: name };
        after.push(() => deps.inOrg(orgId, (ctx) => processGithubPullRequest(ctx, deps, job)));
        payloads.push({ application: app.name, status: "queued", message: "PR webhook received, processing queued." });
      }
    }
    // manualWebhookResponse(): only the authorized payloads; none authorized answers as unauthenticated.
    const authorized = payloads.filter((p) => !(p.status === UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE.status && p.message === UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE.message && Object.keys(p).length === 2));
    if (authorized.length === 0 && payloads.length > 0) return { answer: json([{ ...UNAUTHENTICATED_MANUAL_WEBHOOK_FAILURE }]), after: [] };
    return { answer: json(authorized), after };
  } catch (e) {
    if (e instanceof InvalidWebhookPayload) return { answer: text(e.message), after: [] };
    throw e;
  }
}

/** Github::handleWorkflowJob() with no runner configuration (runners are not ported): what Coolify answers then. */
function workflowJob(app: DeployGithubAppRow, payload: Payload): WebhookAnswer {
  const action = dataGet(payload, "action");
  const rawJobId = dataGet(payload, "workflow_job.id");
  const jobId = typeof rawJobId === "number" ? Math.trunc(rawJobId) : typeof rawJobId === "string" && /^\s*[+-]?\d/.test(rawJobId) ? parseInt(rawJobId, 10) : 0;
  if (!(jobId > 0)) return text("Nothing to do. No workflow job found.");
  const installationId = dataGet(payload, "installation.id");
  const numeric = typeof installationId === "number" || (typeof installationId === "string" && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(installationId));
  if (app.installation_id === null || !numeric || Math.trunc(Number(installationId)) !== Number(app.installation_id)) return text("Nothing to do. The job belongs to another installation of the GitHub App.");
  if (action === "queued") return text("Nothing to do. No runner configuration matches the job labels.");
  if (action === "completed") return text("Queued runner cancelled.");
  return text("Nothing to do.");
}

/** Github::normal(). */
export async function githubAppWebhook(deps: WebhookDeps, delivery: WebhookDelivery): Promise<Handled> {
  const after: AfterAnswer[] = [];
  try {
    const event = (delivery.headers.get("X-GitHub-Event") ?? "").toLowerCase();
    const targetId = delivery.headers.get("X-GitHub-Hook-Installation-Target-Id");
    const signature = afterSha256(delivery.headers.get("X-Hub-Signature-256"));
    const payload = requestPayload(delivery);
    if (event === "ping") return { answer: text("pong"), after };
    const installation = dataGet(payload, "installation.id");
    const installationId = typeof installation === "number" ? Math.trunc(installation) : typeof installation === "string" && /^\s*\d+\s*$/.test(installation) ? Number(installation) : null;
    // Without the header Coolify asks where('app_id', null), which finds its public source (app_id NULL, no
    // secret): "Invalid signature." Freeploy has no such row, so it answers that at once.
    if (targetId === null) return { answer: text("Invalid signature."), after };
    // app_id is an integer column: a target id that is not one names no App.
    const target = targetId !== null && /^\d{1,10}$/.test(targetId) && Number(targetId) <= 2147483647 ? await deps.githubAppTarget(Number(targetId), installationId) : null;
    if (!target) return { answer: text("Nothing to do. No GitHub App found."), after };
    return await deps.inOrg(target.org_id, async (ctx): Promise<Handled> => {
      const app = await ctx.githubApp(target.id);
      if (!app) return { answer: text("Nothing to do. No GitHub App found."), after };
      const secret = app.webhook_secret ? await ctx.decrypt("github_apps.webhook_secret", app.webhook_secret) : null;
      if (secret === null || secret === "") return { answer: text("Invalid signature."), after };
      if (!hashEquals(signature, await hmacSha256Hex(secret, delivery.raw))) return { answer: text("Invalid signature."), after };
      if (event === "installation" || event === "installation_repositories") {
        if (dataGet(payload, "action") === "new_permissions_accepted") after.push(() => deps.inOrg(target.org_id, (c) => c.syncPermissions(app)));
        return { answer: text("cool"), after };
      }
      if (event === "workflow_job") return { answer: workflowJob(app, payload), after };
      let id: number | null = null;
      let branch: string | null = null;
      let commit: string | null = null;
      let changedFiles: string[] | null = null;
      let skip = false;
      let pr: PullRequestPayload | null = null;
      let fullName: string | null = null;
      if (event === "push") {
        id = webhookPayloadDatabaseId(payload, "repository.id");
        branch = webhookPushBranch(dataGet(payload, "ref"));
        commit = webhookCommitSha(payload, "after");
        changedFiles = webhookPushChangedFiles(payload);
        skip = shouldSkipDeploy(webhookPushCommitMessages(payload));
      }
      if (event === "pull_request") {
        id = webhookPayloadDatabaseId(payload, "repository.id");
        pr = readGithubPullRequestPayload(payload);
        branch = pr.branch;
        fullName = manualWebhookRepositoryFullName(dataGet(payload, "repository.full_name"));
        if (fullName === null) return { answer: text("Nothing to do. Invalid repository."), after };
      }
      if (event !== "push" && event !== "pull_request") return { answer: text(`Nothing to do. Event '${event}' is not supported.`), after };
      if (!id || !branch || (event === "pull_request" && pr!.action !== "closed" && !pr!.baseBranch)) return { answer: text("Nothing to do. No id or branch found."), after };
      if (event === "push" && isWebhookBranchDeletionPush(payload)) return { answer: text("Nothing to do. Branch deleted."), after };
      let applications: DeployWebhookApplicationRow[];
      if (event === "push") {
        applications = await ctx.githubAppApplications(app.id, id, branch);
        if (applications.length === 0) return { answer: text(`Nothing to do. No applications found with branch '${branch}'.`), after };
        if (applications.some((a) => a.watch_paths !== null && a.watch_paths.trim() !== "")) {
          // githubPushComparedFiles(): the net change of the push, from the compare API.
          const before = webhookCommitSha(payload, "before");
          const afterSha = webhookCommitSha(payload, "after");
          const name = manualWebhookRepositoryFullName(dataGet(payload, "repository.full_name"));
          if (before !== null && afterSha !== null && name !== null && !/^0+$/.test(before)) {
            const [owner, repo] = [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)];
            changedFiles = (await githubCommitRangeFiles(deps.http, deps.tokens, await ctx.credentials(app), owner, repo, before, afterSha)) ?? changedFiles;
          }
        }
      } else {
        applications = await ctx.githubAppApplications(app.id, id, pr!.action !== "closed" ? pr!.baseBranch : null);
        if (applications.length === 0) return { answer: text(`Nothing to do. No applications found with branch '${pr!.baseBranch ?? ""}'.`), after };
      }
      const payloads: Array<Record<string, unknown>> = [];
      for (const application of byServer(applications)) {
        if (!serverIsFunctional(application)) {
          payloads.push({ status: "failed", message: "Server is not functional.", application_uuid: application.uuid, application_name: application.name });
          continue;
        }
        if (event === "push") {
          if (!application.is_auto_deploy_enabled) {
            payloads.push({ status: "failed", message: "Deployments disabled.", application_uuid: application.uuid, application_name: application.name });
          } else if (!webhookPushMatchesWatchPaths(application.watch_paths, changedFiles)) {
            payloads.push({
              status: "failed",
              message: "Changed files do not match watch paths. Ignoring deployment.",
              application_uuid: application.uuid,
              application_name: application.name,
              details: { changed_files: changedFiles, watch_paths: (application.watch_paths ?? "").split("\n") },
            });
          } else if (skip) {
            payloads.push({ application: application.name, status: "skipped", message: "All commits contain [skip cd] or [skip ci]. Skipping deployment.", application_uuid: application.uuid, application_name: application.name });
          } else {
            void commit;
            payloads.push(pushUnavailable(application, false));
          }
        }
        if (event === "pull_request") {
          if (!application.is_preview_deployments_enabled && pr!.action !== "closed") {
            payloads.push({ application: application.name, status: "failed", message: "Preview deployments disabled." });
            continue;
          }
          const job: PullRequestJob = { application, githubApp: app, pr: pr!, fullName: fullName! };
          after.push(() => deps.inOrg(target.org_id, (c) => processGithubPullRequest(c, deps, job)));
          payloads.push({ application: application.name, status: "queued", message: "PR webhook received, processing queued." });
        }
      }
      return { answer: json(payloads), after };
    });
  } catch (e) {
    if (e instanceof InvalidWebhookPayload) return { answer: text(e.message), after: [] };
    throw e;
  }
}
