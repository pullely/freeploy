<?php
// Runs Coolify's own code (coollabsio/coolify@91b7e3e, Apache-2.0) over cases.json and prints goldens.json —
// nothing here is a port. Git sources and webhooks (freeploy-coolify-parity DP-72). Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// Booted as Coolify's test suite boots it (the `testing` connection: SQLite in memory and every migration),
// time standing still at NOW. GitHub is Http::fake(): each case says what it answers, and every request
// Coolify sends is recorded (method, URL, the headers that matter, the JSON body).
//
// Case kinds:
//   "function"  a helper of Coolify's (bootstrap/helpers/github.php, a webhook concern, a controller's private
//               reader, Application::matchPaths, hash_hmac) and its arguments → { ok, value } | { ok: false, error }
//   "webhook"   a delivery to /webhooks/source/github/events[/manual] through Laravel's HTTP kernel, with the
//               team, servers, applications and GitHub App it is for → the answer (status, content type, body),
//               the previews and deployment rows it left, the jobs it queued, the requests to GitHub
//   "prUpdate"  ApplicationPullRequestUpdateJob::handle() for a preview → the requests to GitHub
//   "deploymentSync"  SyncGithubDeploymentJob::handle() for a deployment → the requests to GitHub and the row
//
// A random value Coolify makes (new_public_id(), a preview's random domain part, the setup state) is written
// as <uuid:n> / <state> where it occurs, numbered by first appearance in the case.

use App\Http\Controllers\Webhook\Concerns\DetectsSkipDeployCommits;
use App\Http\Controllers\Webhook\Concerns\MatchesManualWebhookApplications;
use App\Http\Controllers\Webhook\Concerns\ReadsWebhookPushPayload;
use App\Http\Controllers\Webhook\Github;
use App\Jobs\ApplicationPullRequestUpdateJob;
use App\Jobs\ProcessGithubPullRequestWebhook;
use App\Jobs\SyncGithubDeploymentJob;
use App\Enums\ProcessStatus;
use App\Models\Application;
use App\Models\ApplicationDeploymentQueue;
use App\Models\ApplicationPreview;
use App\Models\GithubApp;
use App\Models\InstanceSettings;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\Server;
use App\Models\StandaloneDocker;
use App\Models\Team;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\RateLimiter;

[$root, $casesFile] = [$argv[1], $argv[2]];
$only = $argv[3] ?? '';
foreach (['DB_CONNECTION' => 'testing', 'APP_ENV' => 'testing', 'QUEUE_CONNECTION' => 'sync', 'CACHE_STORE' => 'array', 'BROADCAST_CONNECTION' => 'null'] as $name => $value) {
    putenv("{$name}={$value}");
    $_ENV[$name] = $_SERVER[$name] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
config(['broadcasting.default' => 'null', 'queue.default' => 'sync', 'cache.default' => 'array', 'app.url' => 'https://app.example.test']);

const NOW = '2026-11-20 10:11:12';

/** A model saved with exactly these attributes, guarded or not. */
function make(string $class, array $attributes)
{
    $model = new $class;
    $model->forceFill($attributes)->save();

    return $model->fresh();
}

/** Replace each random value by a stable placeholder, numbered by first appearance. */
final class Masker
{
    private array $seen = [];

    public function mask(mixed $value, array $randoms): mixed
    {
        if (is_array($value)) {
            $masked = [];
            foreach ($value as $key => $item) {
                $masked[is_string($key) ? $this->mask($key, $randoms) : $key] = $this->mask($item, $randoms);
            }

            return $masked;
        }
        if (! is_string($value)) {
            return $value;
        }
        foreach ($randoms as $random) {
            if ($random === '' || ! str_contains($value, $random)) {
                continue;
            }
            $this->seen[$random] ??= '<uuid:'.(count($this->seen) + 1).'>';
            $value = str_replace($random, $this->seen[$random], $value);
        }

        return $value;
    }
}

/** The protected readers of the webhook concerns, callable. */
function readers(): object
{
    return new class
    {
        use DetectsSkipDeployCommits;
        use MatchesManualWebhookApplications;
        use ReadsWebhookPushPayload;

        public function call(string $method, array $arguments): mixed
        {
            return $this->{$method}(...$arguments);
        }
    };
}

function callFunction(array $case): mixed
{
    $a = $case['args'] ?? [];
    switch ($case['fn']) {
        case 'generateGithubAppJwt':
            Carbon::setTestNow(Carbon::parse($a['now'], 'UTC'));

            return generateGithubAppJwt($a['privateKey'], $a['appId']);
        case 'githubApiUrlFromHtmlUrl':
            return githubApiUrlFromHtmlUrl($a['htmlUrl']);
        case 'normalizeGithubOrganization':
            return normalizeGithubOrganization($a['value']);
        case 'appUrls':
            $source = new GithubApp;
            $source->forceFill(['name' => $a['name'], 'organization' => $a['organization'], 'html_url' => $a['html_url'], 'team_id' => 0, 'id' => 1]);
            $install = getInstallationPath($source);

            return [
                'settingsUrl' => $source->settingsUrl(),
                'permissionsUrl' => getPermissionsPath($source),
                'installationUrl' => preg_replace('/state=[A-Za-z0-9]{64}$/', 'state=<state>', $install),
            ];
        case 'reader':
            // A payload is what $request->collect() gives; a list of messages is a plain array.
            $arguments = ($a['collect'] ?? true) ? array_map(fn ($v) => is_array($v) ? collect($v) : $v, $a['arguments']) : $a['arguments'];
            $value = readers()->call($a['method'], $arguments);

            return $value instanceof Illuminate\Support\Collection ? $value->all() : $value;
        case 'readPullRequestPayload':
        case 'isForkPullRequest':
            $method = new ReflectionMethod(Github::class, $case['fn']);
            $method->setAccessible(true);

            return $method->invoke(new Github, collect($a['payload']));
        case 'matchPaths':
            return Application::matchPaths(collect($a['files']), collect($a['watchPaths']))->all();
        case 'hmac':
            return hash_hmac('sha256', $a['data'], $a['key']);
        case 'hashEquals':
            return hash_equals($a['known'], $a['user']);
        case 'sortBranchesByPriority':
            return sortBranchesByPriority(collect($a['branches']))->pluck('name')->all();
        case 'gitRepositorySlug':
            return gitRepositorySlug($a['value']);
    }
    throw new RuntimeException('Unknown function '.$case['fn']);
}

function migrateFresh(): void
{
    Artisan::call('migrate:fresh', ['--force' => true]);
    InstanceSettings::unguarded(fn () => InstanceSettings::firstOrCreate(['id' => 0]));
    DB::table('instance_settings')->where('id', 0)->update(['fqdn' => 'https://app.example.test']);
    make(GithubApp::class, ['id' => 0, 'uuid' => 'github-public', 'name' => 'Public GitHub', 'api_url' => 'https://api.github.com', 'html_url' => 'https://github.com', 'is_public' => true, 'team_id' => 0]);
}

/** GitHub as the case answers it; every request recorded. */
function fakeGithub(array $answers, array &$requests): void
{
    // A fresh client factory: Http::fake() adds to the stubs of earlier cases, and the first stub that answers wins.
    Http::swap(new Illuminate\Http\Client\Factory(app('events')));
    Http::fake(function (HttpRequest $request) use ($answers, &$requests) {
        $body = $request->body();
        $requests[] = array_filter([
            'method' => $request->method(),
            'url' => $request->url(),
            'authorization' => preg_replace('/^Bearer (?!ghs_).*$/', 'Bearer <jwt>', $request->header('Authorization')[0] ?? ''),
            'accept' => $request->header('Accept')[0] ?? '',
            'body' => $body === '' ? null : json_decode($body, true),
        ], fn ($v) => $v !== null && $v !== '');
        foreach ($answers as $answer) {
            if (preg_match('#'.$answer['match'].'#', $request->method().' '.$request->url()) === 1) {
                return Http::response($answer['body'] ?? [], $answer['status'] ?? 200, $answer['headers'] ?? []);
            }
        }

        return Http::response(['message' => 'Not Found'], 404);
    });
}

/** The team, its servers (one functional unless the case says so), the App and the applications of a case. */
function world(array $setup): array
{
    $team = make(Team::class, ['name' => 'Team', 'personal_team' => false]);
    $key = make(PrivateKey::class, ['uuid' => 'key0000000000000000000001', 'name' => 'key', 'team_id' => $team->id, 'private_key' => $setup['serverKey']]);
    $servers = [];
    foreach ($setup['servers'] as $index => $server) {
        $row = make(Server::class, ['uuid' => 'srv'.str_pad((string) ($index + 1), 22, '0', STR_PAD_LEFT), 'name' => $server['name'], 'ip' => $server['ip'] ?? '10.0.0.'.($index + 2), 'team_id' => $team->id, 'private_key_id' => $key->id]);
        $row->settings->forceFill(['is_reachable' => $server['functional'], 'is_usable' => $server['functional'], 'force_disabled' => false])->save();
        $servers[] = $row;
    }
    // The ids repeat between the rolled-back cases: Server's identity map must not answer an earlier case's row.
    Server::flushIdentityMap();
    $project = make(Project::class, ['uuid' => 'prj0000000000000000000001', 'team_id' => $team->id, 'name' => 'Project']);
    $environment = $project->environments()->first();
    $environment->forceFill(['uuid' => 'env0000000000000000000001'])->save();
    $githubApp = null;
    if (isset($setup['githubApp'])) {
        $appKey = make(PrivateKey::class, ['uuid' => 'key0000000000000000000002', 'name' => 'github-app', 'team_id' => $team->id, 'private_key' => $setup['githubApp']['privateKey'], 'is_git_related' => true]);
        $githubApp = make(GithubApp::class, array_diff_key($setup['githubApp'], ['privateKey' => 1]) + ['uuid' => 'gha0000000000000000000001', 'team_id' => $team->id, 'private_key_id' => $appKey->id, 'api_url' => 'https://api.github.com', 'html_url' => 'https://github.com']);
    }
    $applications = [];
    foreach ($setup['applications'] as $index => $spec) {
        $destination = StandaloneDocker::where('server_id', $servers[$spec['server'] ?? 0]->id)->firstOrFail();
        $source = match ($spec['source'] ?? null) {
            'app' => ['source_id' => $githubApp->id, 'source_type' => GithubApp::class],
            'public' => ['source_id' => 0, 'source_type' => GithubApp::class],
            default => [],
        };
        // The case's own fields first: `+` keeps the left-hand value of a key.
        $application = make(Application::class, array_diff_key($spec, ['server' => 1, 'source' => 1, 'settings' => 1]) + $source + [
            'uuid' => 'app'.str_pad((string) ($index + 1), 22, '0', STR_PAD_LEFT),
            'environment_id' => $environment->id,
            'destination_id' => $destination->id,
            'destination_type' => $destination->getMorphClass(),
            'build_pack' => 'nixpacks',
            'ports_exposes' => '3000',
        ]);
        $application->settings->forceFill($spec['settings'] ?? [])->save();
        $applications[] = $application;
    }
    foreach ($setup['previews'] ?? [] as $index => $preview) {
        make(ApplicationPreview::class, ['uuid' => 'prv'.str_pad((string) ($index + 1), 22, '0', STR_PAD_LEFT), 'application_id' => $applications[$preview['application']]->id] + array_diff_key($preview, ['application' => 1]));
    }
    foreach ($setup['deployments'] ?? [] as $index => $deployment) {
        $application = $applications[$deployment['application']];
        make(ApplicationDeploymentQueue::class, ['deployment_uuid' => 'dep'.str_pad((string) ($index + 1), 22, '0', STR_PAD_LEFT), 'application_id' => $application->id, 'server_id' => $application->destination->server_id] + array_diff_key($deployment, ['application' => 1]));
    }

    return [$team, $githubApp, $applications];
}

function webhook(array $case, $kernel): array
{
    Cache::flush();
    RateLimiter::clear('x');
    Carbon::setTestNow(Carbon::parse(NOW, 'UTC'));
    Queue::fake()->except([ProcessGithubPullRequestWebhook::class]);
    [, , $applications] = world($case['setup']);
    $requests = [];
    fakeGithub($case['github'] ?? [], $requests);
    $headers = [];
    foreach ($case['headers'] as $name => $value) {
        $headers['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;
    }
    if (isset($case['headers']['Content-Type'])) {
        $headers['CONTENT_TYPE'] = $case['headers']['Content-Type'];
    }
    $headers['REMOTE_ADDR'] = '192.0.2.10';
    // A form-encoded body is parsed into the request's fields, as PHP does for $_POST.
    $fields = [];
    if (($case['headers']['Content-Type'] ?? '') === 'application/x-www-form-urlencoded') {
        parse_str($case['body'], $fields);
    }
    $request = Illuminate\Http\Request::create($case['path'], 'POST', $fields, [], [], $headers, $case['body']);
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);
    $uuids = array_map(fn ($a) => $a->uuid, $applications);
    $previews = DB::table('application_previews')->orderBy('id')->get()->map(fn ($p) => [
        'application' => array_search(Application::find($p->application_id)?->uuid, $uuids, true),
        'pull_request_id' => $p->pull_request_id,
        'pull_request_html_url' => $p->pull_request_html_url,
        'fqdn' => $p->fqdn,
        'domain_port_overrides' => $p->domain_port_overrides === null ? null : json_decode($p->domain_port_overrides, true),
        'git_type' => $p->git_type,
        'is_same_repository' => (bool) $p->is_same_repository,
        'docker_compose_domains' => $p->docker_compose_domains,
        'deleted' => $p->deleted_at !== null,
        'uuid' => $p->uuid,
    ])->all();
    $deployments = DB::table('application_deployment_queues')->orderBy('id')->get()->map(fn ($d) => [
        'application' => array_search(Application::find($d->application_id)?->uuid, $uuids, true),
        'status' => $d->status,
        'pull_request_id' => $d->pull_request_id,
        'commit' => $d->commit,
        'commit_message' => $d->commit_message,
        'git_type' => $d->git_type,
        'is_webhook' => (bool) $d->is_webhook,
        'deployment_uuid' => $d->deployment_uuid,
        'deployment_url' => $d->deployment_url,
        'logs' => $d->logs === null ? null : array_map(fn ($l) => $l['output'], json_decode($d->logs, true)),
    ])->all();
    $jobs = [];
    foreach (Queue::pushedJobs() as $class => $pushed) {
        $jobs[] = [$class, count($pushed)];
    }
    $content = $response->getContent();
    $randoms = array_merge(
        array_column($previews, 'uuid'),
        array_column($deployments, 'deployment_uuid'),
        // generatedPreviewDomain()'s {{random}}: a new_public_id() somewhere in the domain.
        ...array_map(fn ($p) => preg_match_all('#(?<![a-z0-9])[a-z0-9]{24}(?![a-z0-9])#', (string) $p['fqdn'], $m) > 0 ? $m[0] : [], $previews),
    );
    $masker = new Masker;

    return $masker->mask([
        'status' => $response->getStatusCode(),
        'contentType' => $response->headers->get('Content-Type'),
        'body' => $content,
        'previews' => array_map(fn ($p) => array_diff_key($p, ['uuid' => 1]), $previews),
        'deployments' => array_map(fn ($d) => array_diff_key($d, ['deployment_uuid' => 1]), $deployments),
        'jobs' => $jobs,
        'requests' => $requests,
    ], array_values(array_filter($randoms)));
}

function prUpdate(array $case): array
{
    Carbon::setTestNow(Carbon::parse(NOW, 'UTC'));
    Queue::fake();
    [, , $applications] = world($case['setup']);
    $application = $applications[0]->fresh();
    $preview = make(ApplicationPreview::class, ['uuid' => 'prv0000000000000000000001', 'application_id' => $application->id] + $case['preview']);
    $requests = [];
    fakeGithub($case['github'] ?? [], $requests);
    $result = (new ApplicationPullRequestUpdateJob($application, $preview, ProcessStatus::from($case['status']), $case['deploymentUuid'] ?? null))->handle();

    return ['requests' => $requests, 'thrown' => $result instanceof Throwable ? $result->getMessage() : null, 'commentId' => $preview->fresh()->pull_request_issue_comment_id];
}

function deploymentSync(array $case): array
{
    Carbon::setTestNow(Carbon::parse(NOW, 'UTC'));
    Queue::fake();
    [, , $applications] = world($case['setup']);
    $application = $applications[0]->fresh();
    foreach ($case['previews'] ?? [] as $preview) {
        make(ApplicationPreview::class, ['uuid' => 'prv0000000000000000000001', 'application_id' => $application->id] + $preview);
    }
    $deployment = make(ApplicationDeploymentQueue::class, ['application_id' => $application->id, 'deployment_uuid' => 'dep0000000000000000000001', 'server_id' => $application->destination->server_id] + $case['deployment']);
    $requests = [];
    fakeGithub($case['github'] ?? [], $requests);
    $thrown = null;
    try {
        (new SyncGithubDeploymentJob($deployment->id, $case['deactivate'] ?? false))->handle();
    } catch (Throwable $e) {
        $thrown = $e->getMessage();
    }
    $row = $deployment->fresh();

    return ['requests' => $requests, 'thrown' => $thrown, 'github_deployment_id' => $row->github_deployment_id, 'github_deployment_state' => $row->github_deployment_state];
}

$cases = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR);
$out = ['now' => Carbon::parse(NOW, 'UTC')->toJSON(), 'functions' => [], 'webhooks' => [], 'prUpdates' => [], 'deploymentSyncs' => []];
migrateFresh();
foreach ($cases['functions'] as $case) {
    if ($only !== '' && ! str_starts_with($case['id'], $only)) {
        continue;
    }
    try {
        $out['functions'][$case['id']] = ['ok' => true, 'value' => callFunction($case)];
    } catch (Throwable $e) {
        $out['functions'][$case['id']] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}
foreach (['webhooks' => 'webhook', 'prUpdates' => 'prUpdate', 'deploymentSyncs' => 'deploymentSync'] as $group => $runner) {
    foreach ($cases[$group] ?? [] as $case) {
        if ($only !== '' && ! str_starts_with($case['id'], $only)) {
            continue;
        }
        DB::beginTransaction();
        try {
            $out[$group][$case['id']] = $runner === 'webhook' ? webhook($case, $kernel) : $runner($case);
        } finally {
            DB::rollBack();
        }
    }
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
