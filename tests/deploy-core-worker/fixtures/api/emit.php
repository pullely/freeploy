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

use App\Models\Application;
use App\Models\ApplicationDeploymentQueue;
use App\Models\Environment;
use App\Models\EnvironmentVariable;
use App\Models\InstanceSettings;
use App\Models\PersonalAccessToken;
use App\Models\PrivateKey;
use App\Models\S3Storage;
use App\Models\ScheduledDatabaseBackup;
use App\Models\ScheduledDatabaseBackupExecution;
use App\Models\Project;
use App\Models\Server;
use App\Models\Service;
use App\Models\SharedEnvironmentVariable;
use App\Models\ServiceApplication;
use App\Models\ServiceDatabase;
use App\Models\StandaloneDocker;
use App\Models\Tag;
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
    foreach (['teams', 'users', 'team_user', 'projects', 'environments', 'private_keys', 'servers', 'server_settings', 'standalone_dockers', 'personal_access_tokens', 'applications', 'application_settings', 'environment_variables', 'application_deployment_queues', 's3_storages', 'standalone_postgresqls', 'standalone_redis', 'standalone_mongodbs', 'standalone_mysqls', 'standalone_mariadbs', 'standalone_keydbs', 'standalone_dragonflies', 'standalone_clickhouses', 'local_persistent_volumes', 'scheduled_database_backups', 'scheduled_database_backup_executions', 'scheduled_database_backup_s3_storage', 'services', 'service_applications', 'service_databases', 'tags'] as $table) {
        DB::statement("SELECT setval(pg_get_serial_sequence('{$table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM {$table}), 1))");
    }
};
Bus::fake();
Queue::fake();
Notification::fake();
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
\Carbon\CarbonImmutable::setTestNow(\Carbon\CarbonImmutable::parse('2026-01-01T00:00:00Z'));

$fixture = $cases['fixture'];

// DP-81: host names as SafeWebhookUrl resolves them (no DNS is asked): an S3 storage's endpoint.
\App\Rules\SafeWebhookUrl::resolveHostsUsing(fn (string $host): array => match ($host) {
    'unresolvable.example' => [],
    'private.example' => ['10.0.0.5'],
    default => ['93.184.216.34'],
});

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
// The server's created hook made its default destination with a random uuid: give it the fixture's (DP-71).
foreach ($fixture['destinations'] ?? [] as $d) {
    DB::table('standalone_dockers')->where('server_id', $d['server_id'])->update(['id' => $d['id'], 'uuid' => $d['uuid']]);
}
$advanceSequences();
// Applications and their variables through the models, so the creating and created hooks run (DP-71).
foreach ($fixture['applications'] ?? [] as $a) {
    Application::unguarded(fn () => Application::query()->forceCreate(['id' => $a['id'], 'uuid' => $a['uuid'], 'name' => $a['name'], 'fqdn' => $a['fqdn'], 'environment_id' => $a['environment_id'], 'destination_id' => $a['destination_id'], 'destination_type' => StandaloneDocker::class] + $a['columns']));
}
$advanceSequences();
foreach ($fixture['variables'] ?? [] as $v) {
    EnvironmentVariable::unguarded(fn () => EnvironmentVariable::query()->create(['uuid' => $v['uuid'], 'key' => $v['key'], 'value' => $v['value'], 'comment' => $v['comment'], 'is_literal' => $v['is_literal'], 'is_multiline' => $v['is_multiline'], 'is_shown_once' => $v['is_shown_once'], 'is_runtime' => $v['is_runtime'], 'is_buildtime' => $v['is_buildtime'], 'is_preview' => false, 'resourceable_type' => Application::class, 'resourceable_id' => $v['application']]));
}
// DP-73: an S3 storage per team, the standalone databases through Coolify's create_standalone_<engine>() helpers (the
// created hook's volumes, Redis's two variables), their backup schedules and two executions (the created hook writes the
// schedule's last_execution_at).
$advanceSequences();
foreach ($fixture['s3Storages'] ?? [] as $s) {
    S3Storage::unguarded(fn () => S3Storage::query()->forceCreate(['id' => $s['id'], 'uuid' => $s['uuid'], 'name' => $s['name'], 'description' => $s['description'], 'region' => $s['region'], 'key' => $s['key'], 'secret' => $s['secret'], 'bucket' => $s['bucket'], 'endpoint' => $s['endpoint'], 'is_usable' => $s['is_usable'], 'team_id' => $s['team']]));
}
$advanceSequences();
foreach ($fixture['databases'] ?? [] as $d) {
    $create = 'create_standalone_'.$d['engine'];
    // The helper saves through the model: the table's sequence gives the fixture's id.
    $table = (new ('App\\Models\\Standalone'.['postgresql' => 'Postgresql', 'redis' => 'Redis', 'mongodb' => 'Mongodb', 'mysql' => 'Mysql', 'mariadb' => 'Mariadb', 'keydb' => 'Keydb', 'dragonfly' => 'Dragonfly', 'clickhouse' => 'Clickhouse'][$d['engine']]))->getTable();
    DB::statement("SELECT setval(pg_get_serial_sequence('{$table}', 'id'), {$d['id']}, false)");
    $create($d['environment_id'], StandaloneDocker::query()->find($d['destination_id']), ['uuid' => $d['uuid'], 'name' => $d['name']] + $d['columns']);
}
$advanceSequences();
$morph = ['postgresql' => \App\Models\StandalonePostgresql::class, 'mysql' => \App\Models\StandaloneMysql::class];
foreach ($fixture['backups'] ?? [] as $b) {
    $backup = ScheduledDatabaseBackup::unguarded(fn () => ScheduledDatabaseBackup::query()->forceCreate(['id' => $b['id'], 'uuid' => $b['uuid'], 'team_id' => $b['team'], 'database_type' => $morph[$b['engine']], 'database_id' => $b['database_id'], 'frequency' => $b['frequency'], 'save_s3' => $b['save_s3'], 'databases_to_backup' => $b['databases_to_backup'], 'enabled' => true, 'created_at' => $b['created_at'], 'updated_at' => $b['created_at']]));
    if ($b['s3']) {
        $backup->syncS3Storages($b['s3']);
    }
}
$advanceSequences();
foreach ($fixture['executions'] ?? [] as $x) {
    ScheduledDatabaseBackupExecution::unguarded(fn () => ScheduledDatabaseBackupExecution::query()->forceCreate(['id' => $x['id'], 'uuid' => $x['uuid'], 'scheduled_database_backup_id' => $x['backup'], 'status' => $x['status'], 'message' => $x['message'], 'size' => $x['size'], 'filename' => $x['filename'], 'database_name' => $x['database_name'], 'created_at' => $x['created_at'], 'updated_at' => $x['created_at'], 'finished_at' => $x['finished_at']]));
}
// DP-74: services with fixed columns (forceCreate(): the creating hook gives the parser version), their applications and
// databases (the saving hooks normalize the domains), and their variables through the model.
$advanceSequences();
foreach ($fixture['services'] ?? [] as $s) {
    Service::unguarded(fn () => Service::query()->forceCreate(['id' => $s['id'], 'uuid' => $s['uuid'], 'name' => $s['name'], 'description' => $s['description'], 'docker_compose_raw' => $s['docker_compose_raw'], 'docker_compose' => $s['docker_compose'], 'service_type' => $s['service_type'], 'environment_id' => $s['environment_id'], 'server_id' => $s['server_id'], 'destination_id' => $s['destination_id'], 'destination_type' => StandaloneDocker::class]));
}
foreach ($fixture['serviceApplications'] ?? [] as $a) {
    ServiceApplication::unguarded(fn () => ServiceApplication::query()->forceCreate(['id' => $a['id'], 'uuid' => $a['uuid'], 'service_id' => $a['service'], 'name' => $a['name'], 'image' => $a['image'], 'fqdn' => $a['fqdn']]));
}
foreach ($fixture['serviceDatabases'] ?? [] as $d) {
    ServiceDatabase::unguarded(fn () => ServiceDatabase::query()->forceCreate(['id' => $d['id'], 'uuid' => $d['uuid'], 'service_id' => $d['service'], 'name' => $d['name'], 'image' => $d['image']]));
}
$advanceSequences();
foreach ($fixture['serviceVariables'] ?? [] as $v) {
    EnvironmentVariable::unguarded(fn () => EnvironmentVariable::query()->create(['uuid' => $v['uuid'], 'key' => $v['key'], 'value' => $v['value'], 'comment' => $v['comment'], 'is_shown_once' => $v['is_shown_once'], 'is_preview' => false, 'resourceable_type' => Service::class, 'resourceable_id' => $v['service']]));
}
// DP-74: deployments in the queue, with fixed columns (forceCreate(); application_id is a string column).
foreach ($fixture['deployments'] ?? [] as $q) {
    ApplicationDeploymentQueue::unguarded(fn () => ApplicationDeploymentQueue::query()->forceCreate(['id' => $q['id'], 'deployment_uuid' => $q['uuid'], 'application_id' => (string) $q['application'], 'status' => $q['status'], 'commit' => $q['commit'], 'server_id' => $q['server_id'], 'destination_id' => (string) $q['destination_id'], 'application_name' => $q['application_name'], 'server_name' => $q['server_name'], 'logs' => $q['logs'], 'created_at' => $q['created_at'], 'updated_at' => $q['created_at'], 'finished_at' => $q['finished_at']]));
}
// DP-81: tags with the team (forceCreate(): the name through the model's mutator) and the pivot rows, in the fixture's order.
$advanceSequences();
foreach ($fixture['tags'] ?? [] as $t) {
    Tag::unguarded(fn () => Tag::query()->forceCreate(['id' => $t['id'], 'uuid' => $t['uuid'], 'name' => $t['name'], 'team_id' => $t['team'], 'created_at' => $t['created_at'], 'updated_at' => $t['created_at']]));
}
$taggable = ['application' => Application::class, 'redis' => \App\Models\StandaloneRedis::class, 'service' => Service::class];
foreach ($fixture['taggables'] ?? [] as $p) {
    DB::table('taggables')->insert(['tag_id' => $p['tag'], 'taggable_type' => $taggable[$p['type']], 'taggable_id' => $p['id']]);
}
// DP-81: shared variables of projects and environments, through the model (the encrypted cast, the key's mutator).
foreach ($fixture['sharedVariables'] ?? [] as $v) {
    SharedEnvironmentVariable::unguarded(fn () => SharedEnvironmentVariable::query()->forceCreate(['id' => $v['id'], 'key' => $v['key'], 'value' => $v['value'], 'type' => $v['type'], 'team_id' => $v['team'], 'project_id' => $v['project_id'], 'environment_id' => $v['environment_id'], 'is_literal' => $v['is_literal'], 'is_multiline' => $v['is_multiline'], 'is_shown_once' => $v['is_shown_once'], 'comment' => $v['comment']]));
}
// Not in $advanceSequences: the servers' created hook took the first ids from the sequence, which must not be moved before.
DB::statement("SELECT setval(pg_get_serial_sequence('shared_environment_variables', 'id'), (SELECT MAX(id) FROM shared_environment_variables))");
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
    // As PHP and Request::capture() make it: a form body is parsed into the request bag ($_POST), and createFromBase() makes a
    // JSON body the request bag too, which $request->get() reads (DP-71).
    $parameters = [];
    if ($content !== null && str_starts_with($server['CONTENT_TYPE'], 'application/x-www-form-urlencoded')) {
        parse_str($content, $parameters);
    }
    $request = Request::createFromBase(\Symfony\Component\HttpFoundation\Request::create($step['path'], $step['method'], $parameters, [], [], $server, $content));
    // A new request each time: forget the user Sanctum resolved for the previous one, and the servers the previous request
    // loaded (Server's request-scoped identity map is static: in one PHP process it would outlive the request, DP-71).
    $app['auth']->forgetGuards();
    \App\Models\Server::flushIdentityMap();
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

// The column order of the tables whose rows the API writes as Eloquent's toArray() gives them, without serializeApiResponse()'s
// sorting (a nested relation, such as an application's destination, its server and their settings): the schema's order (DP-71).
$columns = [];
foreach ($cases['columnsOf'] ?? [] as $table) {
    $columns[$table] = array_map(fn ($c) => $c->column_name, DB::select("select column_name from information_schema.columns where table_schema = 'public' and table_name = ? order by ordinal_position", [$table]));
}

echo json_encode(['coolify' => '91b7e3e', 'version' => config('constants.coolify.version'), 'columns' => $columns, 'cases' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
