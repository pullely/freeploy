<?php
// Calls Coolify's real /api/v1 — coollabsio/coolify@91b7e3e (Apache-2.0); nothing in here is a port — and
// prints what it answers, so that Freeploy's /api/v1 can be replayed against it (see README.md).
//
//   DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=… DB_USERNAME=… DB_PASSWORD=… \
//     php emit.php <coolify root with vendor/ and a .env> <cases.json> > goldens.json
//
// Database: PostgreSQL, Coolify's production database (`pgsql`, `migrate:fresh` with all of its migrations),
// not the SQLite of its test suite: the API serializes model attributes as the driver returns them, and
// SQLite returns a boolean column without a cast as 0/1 where PostgreSQL returns false/true (and
// ApiAllowed's `is_api_enabled === false` is never true on SQLite). The fixture below is made once; every case runs in a transaction that is rolled back, with an
// empty cache (so the rate limiters start from zero), unless it is a step of a `sequence`, whose steps share
// one transaction and one cache. Each request goes through Laravel's HTTP kernel exactly as a request from
// a client would: the global middleware (ThrottleFailedApiRequests among them), the `api` group's
// `throttle:api`, then the route's auth:sanctum, api.token.team, ApiAllowed, api.sensitive and api.ability.
//
// Fixed: the clock (2026-01-01T00:00:00Z), every id and uuid of the fixture, the tokens' plain text. The
// uuid of what a case creates is Coolify's random one; the test masks it (README.md, "Masking").

use App\Models\Environment;
use App\Models\InstanceSettings;
use App\Models\PersonalAccessToken;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\Server;
use App\Models\Team;
use App\Models\User;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Queue;

$root = $argv[1];
$cases = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);

// Production-like: no debug pages, the array cache (Laravel's rate limiter and Coolify's failed-request
// throttle keep their counters there), jobs not run.
foreach (['DB_CONNECTION' => 'pgsql', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array', 'APP_DEBUG' => 'false', 'APP_MAINTENANCE_STORE' => 'array', 'LOG_CHANNEL' => 'null'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
// Some of Coolify's migrations print progress; keep it out of the goldens.
ob_start();
Artisan::call('migrate:fresh', ['--force' => true]);
ob_end_clean();
/** The fixture's ids are given; what is created after them (a user's personal team, a case's rows) continues after them. */
$advanceSequences = function (): void {
    foreach (['teams', 'users', 'team_user', 'projects', 'environments', 'private_keys', 'servers', 'server_settings', 'standalone_dockers', 'personal_access_tokens'] as $table) {
        DB::statement("SELECT setval(pg_get_serial_sequence('{$table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM {$table}), 1))");
    }
};
Bus::fake();
Queue::fake();
Notification::fake();
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
\Carbon\CarbonImmutable::setTestNow(\Carbon\CarbonImmutable::parse('2026-01-01T00:00:00Z'));

$fixture = $cases['fixture'];

// ── the fixture ─────────────────────────────────────────────────────────────
InstanceSettings::unguarded(fn () => InstanceSettings::query()->updateOrCreate(['id' => 0], ['is_api_enabled' => true, 'allowed_ips' => null]));
foreach ($fixture['teams'] as $t) {
    Team::unguarded(fn () => Team::query()->forceCreate(['id' => $t['id'], 'name' => $t['name'], 'description' => $t['description'], 'personal_team' => $t['personal_team']]));
}
$advanceSequences();
foreach ($fixture['users'] as $u) {
    $user = User::unguarded(fn () => User::query()->forceCreate(['id' => $u['id'], 'name' => $u['name'], 'email' => $u['email'], 'password' => bcrypt('password'), 'current_team_id' => $u['teams'][0]['team']]));
    foreach ($u['teams'] as $m) {
        $user->teams()->attach($m['team'], ['role' => $m['role']]);
    }
}
$advanceSequences();
foreach ($fixture['projects'] as $p) {
    $project = Project::unguarded(fn () => Project::query()->forceCreate(['id' => $p['id'], 'uuid' => $p['uuid'], 'name' => $p['name'], 'description' => $p['description'], 'team_id' => $p['team']]));
    // Project's created hook made "production" with a random uuid: give the fixture's ids to its environments.
    $project->environments()->delete();
    foreach ($p['environments'] as $e) {
        Environment::unguarded(fn () => Environment::query()->forceCreate(['id' => $e['id'], 'uuid' => $e['uuid'], 'name' => $e['name'], 'description' => $e['description'], 'project_id' => $p['id']]));
    }
}
$advanceSequences();
foreach ($fixture['privateKeys'] as $k) {
    PrivateKey::unguarded(fn () => PrivateKey::query()->forceCreate(['id' => $k['id'], 'uuid' => $k['uuid'], 'name' => $k['name'], 'description' => $k['description'], 'private_key' => file_get_contents(__DIR__.'/'.$k['file']), 'team_id' => $k['team'], 'is_git_related' => false]));
}
$advanceSequences();
foreach ($fixture['servers'] ?? [] as $s) {
    Server::unguarded(fn () => Server::query()->forceCreate(['id' => $s['id'], 'uuid' => $s['uuid'], 'name' => $s['name'], 'description' => $s['description'], 'ip' => $s['ip'], 'user' => $s['user'], 'port' => $s['port'], 'team_id' => $s['team'], 'private_key_id' => $s['private_key_id']]));
}
// Tokens: the fixture's plain text, hashed as Sanctum stores it; the client sends "<id>|<plain text>".
$advanceSequences();
foreach ($fixture['tokens'] as $t) {
    PersonalAccessToken::unguarded(fn () => PersonalAccessToken::query()->forceCreate([
        'id' => $t['id'],
        'tokenable_type' => User::class,
        'tokenable_id' => $t['user'],
        'name' => $t['name'],
        'token' => hash('sha256', $t['secret']),
        'abilities' => $t['abilities'],
        'team_id' => $t['team'],
        'expires_at' => $t['expires_at'] ?? null,
    ]));
}

$advanceSequences();

// ── the requests ────────────────────────────────────────────────────────────
$kernel = $app->make(HttpKernel::class);
$tokens = collect($fixture['tokens'])->keyBy('key');

$send = function (array $step) use ($kernel, $tokens, $app): array {
    $server = ['HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => $step['ip'] ?? '203.0.113.50'];
    if (isset($step['token'])) {
        $server['HTTP_AUTHORIZATION'] = 'Bearer '.($tokens[$step['token']]['id'] ?? '').'|'.($tokens[$step['token']]['secret'] ?? '');
    }
    if (isset($step['authorization'])) {
        $server['HTTP_AUTHORIZATION'] = $step['authorization'];
    }
    $content = null;
    if (array_key_exists('raw', $step)) {
        $content = $step['raw'];
        $server['CONTENT_TYPE'] = $step['contentType'] ?? 'application/json';
    } elseif (array_key_exists('body', $step)) {
        $content = json_encode($step['body'], JSON_UNESCAPED_SLASHES);
        $server['CONTENT_TYPE'] = 'application/json';
    }
    $request = Request::create($step['path'], $step['method'], [], [], [], $server, $content);
    // A new request each time: forget the user Sanctum resolved for the previous one.
    $app['auth']->forgetGuards();
    $response = $kernel->handle($request);
    $kernel->terminate($request, $response);
    $text = $response->getContent();
    $json = json_decode($text, true);
    $headers = [];
    foreach (['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after', 'x-ratelimit-reset'] as $h) {
        if ($response->headers->has($h)) {
            $headers[$h] = $response->headers->get($h);
        }
    }

    return ['status' => $response->getStatusCode(), 'headers' => $headers, 'body' => json_last_error() === JSON_ERROR_NONE && $text !== '' ? ['json' => $text] : ['text' => $text]];
};

$out = [];
foreach ($cases['cases'] as $case) {
    DB::beginTransaction();
    Cache::flush();
    \Illuminate\Support\Once::flush();
    $settings = InstanceSettings::query()->find(0);
    $settings->forceFill(['is_api_enabled' => $case['instance']['is_api_enabled'] ?? true, 'allowed_ips' => $case['instance']['allowed_ips'] ?? null])->saveQuietly();
    Cache::flush();
    config(['api.rate_limit' => $case['config']['rate_limit'] ?? 200, 'api.failed_request_rate_limit' => $case['config']['failed_request_rate_limit'] ?? 30]);
    foreach ($case['setup'] ?? [] as $sql) {
        DB::statement($sql);
    }
    $steps = $case['sequence'] ?? [$case];
    $results = [];
    foreach ($steps as $step) {
        if (isset($step['advance'])) {
            Carbon::setTestNow(Carbon::now()->addSeconds($step['advance']));
        }
        \Illuminate\Support\Once::flush();
        $results[] = $send($step);
    }
    Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
    $after = [];
    foreach ($case['after'] ?? [] as $label => $sql) {
        $after[$label] = DB::select($sql);
    }
    DB::rollBack();
    $out[] = ['name' => $case['name']] + (isset($case['sequence']) ? ['steps' => $results] : $results[0]) + ($after ? ['after' => $after] : []);
}

echo json_encode(['coolify' => '91b7e3e', 'version' => config('constants.coolify.version'), 'cases' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
