# Git source and webhook goldens (DP-72)

What Coolify's own PHP does with a GitHub App source and with a Git webhook delivery, so that the
TypeScript ports in `apps/deploy-core-worker/src/sources/` can be held to it.

- `cases.json` — the cases, in four groups:
  - `functions` (169): one helper of Coolify's and its arguments — `generateGithubAppJwt` (5), the
    GitHub URL helpers (`githubApiUrlFromHtmlUrl`, `normalizeGithubOrganization`, the App's settings,
    permissions and installation URLs), the webhook payload readers of the controllers' concerns
    (90), `readPullRequestPayload` and `isForkPullRequest` (12 each), `Application::matchPaths` (16),
    `hash_hmac` and `hash_equals`, the branch order of `loadBranches()`, and the repository slug the
    jobs send to.
  - `webhooks` (56): one delivery to `/webhooks/source/github/events/manual` (33) or
    `/webhooks/source/github/events` (23) — the team, servers, applications, previews and GitHub App
    it is for, its headers and raw body, and what GitHub answers. Push and pull request events, ping,
    installation, `workflow_job`, good, bad and missing signatures, unknown events, malformed and
    non-JSON bodies, watch paths, `[skip ci]` commits, branch deletions, forks, and servers that are
    and are not functional.
  - `prUpdates` (11): `ApplicationPullRequestUpdateJob::handle()` for a preview.
  - `deploymentSyncs` (15): `SyncGithubDeploymentJob::handle()` for a deployment.
- `emit.php` — runs every case through Coolify's real code and prints the results. Nothing in it is
  a port. It boots the Laravel application as Coolify's own test suite does (the `testing`
  connection: SQLite in memory and every migration), with time standing still. Each case is a
  database transaction that is rolled back. GitHub is `Http::fake()`, swapped for a new factory per
  case: each case says what GitHub answers, and every request Coolify sends is recorded (method,
  URL, the headers that matter, the JSON body). Queued jobs are `Queue::fake()`, except the pull
  request job, which a webhook case runs as Coolify's queue would. A delivery goes through Laravel's
  HTTP kernel, so its answer is what the route answers: status, content type and body.
- `goldens.json` — its output. Never edited by hand. A random value Coolify makes (`new_public_id()`,
  a preview's random domain part, the setup state) is written as `<uuid:n>` / `<state>`, numbered by
  first appearance in the case.

**Test keys only.** The RSA key of the GitHub App cases and the ed25519 deploy keys in this
directory and in `../deployments/cases.json` were made for these cases. They protect nothing and
are registered nowhere. The installation tokens, webhook secrets and client secrets are made up.

## What the tests compare

- `src/sources-functions.test.ts` — every function case, and the requests of every `prUpdates` and
  `deploymentSyncs` case, built by the pure request builders of `sources/pr-updates.ts`. The JWT is
  compared byte for byte and also verified by the system `openssl` against the key's public half.
- `src/sources-webhooks.test.ts` — every webhook case, replayed through Freeploy's receiver over an
  in-memory store built from the same rows: the answer, the preview rows, the skipped deployments
  and the requests to GitHub must be the same.
- `src/deployments-engine.test.ts` replays the private repository runs of `../deployments`
  (`ghapp.*`, `deploykey.*`), whose clone commands come from the same emitter as every other build.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, prepared as `../deployments/README.md`
says (`composer install`, a `.env`):

```sh
php /path/to/freeploy/tests/deploy-core-worker/fixtures/sources/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/sources/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/sources/goldens.json
```

A third argument keeps only the cases whose id starts with it (for looking at one case, not for
the committed file). Two runs of the emitter give the same file. `cases.json` is the artifact: it
was first written by a script and is edited as JSON since.

## What the port does differently, on purpose

- Where Coolify queues a deployment ("Deployment queued."), Freeploy answers that deploying needs
  the SSH executor, which is not available yet, and stores no deployment row. No Freeploy server is
  reachable today, so a delivery for a real server answers "Server is not functional." as Coolify
  does for one it cannot reach.
- Coolify queues the cleanup of a closed pull request's preview; Freeploy deletes the row at once
  when no deployment of it was ever queued, and keeps it otherwise.
- The pull request job runs inline, after the answer, rather than on a queue.
- The requests of `ApplicationPullRequestUpdateJob` and `SyncGithubDeploymentJob` are built but
  never sent: there are no deployments to report on yet.
- A text that names Coolify in prose reads "Freeploy" (the tests apply the same rule to the golden).
- A GitHub API error that Coolify joins with an HTML `<br>` (`githubApi()`) is joined with a newline;
  the deployment replay maps one to the other before comparing.
- One installation token is fetched per delivery or deployment step and reused, where Coolify asks
  GitHub for a new one per call.

## Not covered

GitLab, Gitea and Bitbucket sources and webhooks (Freeploy answers 501, "not available yet"); the
GitHub App OAuth login; Coolify's runner configurations for `workflow_job`; the failed-signature
throttle (429); a Docker Compose application's preview domains; and GitHub Enterprise Server hosts
(the emitter has no DNS).
