<?php
// Runs Coolify's own database start, stop, restart and TCP proxy code (coollabsio/coolify@91b7e3e, Apache-2.0)
// over cases.json and prints goldens.json — nothing here is a port. Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// The application is booted as Coolify's own test suite boots it: the `testing` connection (SQLite in
// memory), the schema of database/schema/testing-schema.sql and every later migration. Each case builds its
// team, server, destination, project, environment and database as real models, with the database's volumes,
// file mounts, variables and certificates, and calls the real action:
//
//   start        StartDatabase::run($database)      — then the DatabaseStartJob it queued is run as a queue worker
//                                                     runs it (handle(), and failed() when that throws), so
//                                                     the engine's Start action, DatabaseStartCommandExecutor
//                                                     and ResourceStatusRefresher all run
//   restart      RestartDatabase::run($database)
//   stop         StopDatabase::run($database, false, $dockerCleanup)   — as Heading::stop() dispatches it
//   proxy-start  StartDatabaseProxy::run($database)
//   proxy-stop   StopDatabaseProxy::run($database)
//
// No server is contacted: Process::fake() answers every SSH process with what the case scripts and records
// the script it was given. Sleep, notifications, the other queued jobs and the broadcast events are Laravel's
// fakes, and time stands still.
//
// Output:
//   { "now": the instant every run stands still at,
//     "strings": [...],
//     "runs": { "<case id>": {
//        result      what the action returned: { "activity": true } or a string
//        thrown      "<class>: <message>" when it threw
//        jobThrown   "<class>: <message>" when the queued DatabaseStartJob threw
//        processes   every SSH process in order: { script [, output, errorOutput, exitCode] }
//        activity    the start's activity: { status, exitCode, error, log: [{ type, output }] } or null
//        database    the row afterwards: status, started_at, last_online_at, is_public, the restart counters
//                    (restart_count, last_restart_at, last_restart_type) and the engine's configuration column
//        certificates, fileStorages   the rows afterwards (a generated certificate or key as its mask, see below)
//        variables   key and stored value of each variable afterwards
//        jobs, notifications, events, sleeps
//     } } }
//
// Certificates. A case can give the server's CA and the database's certificate (`caCertificate`,
// `certificate`): then nothing is random and every byte is Coolify's. Where Coolify generates one
// (SslHelper::generateSslCertificate, with a fresh key and a random serial), the generated PEM texts are not
// reproducible, so the emitter replaces each of them — in every script, wherever its base64 form stands, and in
// the rows — by a mask: {{generated:ca-certificate}}, {{generated:certificate}}, {{generated:private-key}},
// {{generated:certificate-and-key}} (the certificate, a line break, the key: MongoDB's server.pem). The
// TypeScript test masks its own generated texts the same way before comparing. `generated` gives what can be
// said about them: subject, issuer, alternative names, days of validity, the key's curve and the signature.
//
// To keep the file small: a process leaves out `output` and `errorOutput` when empty and `exitCode` when 0; a
// string of 150 characters or more that occurs more than once is written once in `strings` and stands as
// { "$string": <its index> } where it occurs.

use App\Actions\Database\RestartDatabase;
use App\Actions\Database\StartDatabase;
use App\Actions\Database\StartDatabaseProxy;
use App\Actions\Database\StopDatabase;
use App\Actions\Database\StopDatabaseProxy;
use App\Jobs\DatabaseStartJob;
use App\Models\EnvironmentVariable;
use App\Models\InstanceSettings;
use App\Models\LocalPersistentVolume;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\Server;
use App\Models\SharedEnvironmentVariable;
use App\Models\SslCertificate;
use App\Models\StandaloneClickhouse;
use App\Models\StandaloneDocker;
use App\Models\StandaloneDragonfly;
use App\Models\StandaloneKeydb;
use App\Models\StandaloneMariadb;
use App\Models\StandaloneMongodb;
use App\Models\StandaloneMysql;
use App\Models\StandalonePostgresql;
use App\Models\StandaloneRedis;
use App\Models\Team;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Sleep;
use Spatie\Activitylog\Models\Activity;

[$root, $casesFile] = [$argv[1], $argv[2]];
// Optional: only the cases whose id starts with this (while working on one).
$only = $argv[3] ?? '';
foreach (['DB_CONNECTION' => 'testing', 'APP_ENV' => 'testing', 'QUEUE_CONNECTION' => 'sync', 'CACHE_STORE' => 'array', 'BROADCAST_CONNECTION' => 'null'] as $name => $value) {
    putenv("{$name}={$value}");
    $_ENV[$name] = $_SERVER[$name] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$scratch = sys_get_temp_dir().'/freeploy-database-start-goldens-'.getmypid();
@mkdir($scratch, 0700, true);
config([
    // One SSH process per command batch, as on a server without connection sharing.
    'constants.ssh.mux_enabled' => false,
    'filesystems.disks.ssh-keys.root' => $scratch.'/keys',
    'filesystems.disks.ssh-mux.root' => $scratch.'/mux',
    'broadcasting.default' => 'null',
    'queue.default' => 'sync',
    'cache.default' => 'array',
    'activitylog.enabled' => true,
]);

const NOW = '2026-11-20 10:11:12';
const LAST_ONLINE_AT = '2026-11-01 00:00:00';
// The ed25519 test key of the SSH key fixtures; the goldens do not depend on its content.
define('PRIVATE_KEY', file_get_contents(__DIR__.'/../ssh-keys/ed25519.openssh'));

const MODELS = [
    'postgresql' => StandalonePostgresql::class,
    'redis' => StandaloneRedis::class,
    'mongodb' => StandaloneMongodb::class,
    'mysql' => StandaloneMysql::class,
    'mariadb' => StandaloneMariadb::class,
    'keydb' => StandaloneKeydb::class,
    'dragonfly' => StandaloneDragonfly::class,
    'clickhouse' => StandaloneClickhouse::class,
];

/** The engine's configuration column, which a start can rewrite (PostgreSQL's listen_addresses). */
const CONF_COLUMNS = ['postgresql' => 'postgres_conf', 'redis' => 'redis_conf', 'mongodb' => 'mongo_conf', 'mysql' => 'mysql_conf', 'mariadb' => 'mariadb_conf', 'keydb' => 'keydb_conf'];

/** array_replace_recursive, except that a list in the override replaces the default's list. */
function merged(array $base, array $over): array
{
    foreach ($over as $key => $value) {
        $base[$key] = is_array($value) && ! array_is_list($value) && isset($base[$key]) && is_array($base[$key]) && ! array_is_list($base[$key])
            ? merged($base[$key], $value)
            : $value;
    }

    return $base;
}

/** A model saved with exactly these attributes, guarded or not. */
function make(string $class, array $attributes)
{
    $model = new $class;
    $model->forceFill($attributes)->save();

    return $model->fresh();
}

/**
 * The remote side of one faked SSH process: a command batch on the remote shell's stdin
 * (SshMultiplexingHelper::generateSshBatchCommand). Null for the host key probe, which runs no command on the
 * server.
 */
function remoteScript(PendingProcess $process): ?string
{
    $command = is_array($process->command) ? implode(' ', $process->command) : (string) $process->command;
    $input = is_string($process->input) ? $process->input : null;
    if (str_ends_with($command, "exec bash -se; else exec sh -se; fi\"'")) {
        // sshBatchInput() ends the batch with one line break.
        return substr((string) $input, 0, -strlen(PHP_EOL));
    }
    if (preg_match("/ -- '[^']*'@'[^']*' (.*)\\z/s", $command, $match) === 1 && $match[1] === 'true') {
        return null;
    }
    throw new RuntimeException("Not an SSH command batch: {$command}");
}

function migrateFresh(): void
{
    Artisan::call('migrate:fresh', ['--force' => true]);
    InstanceSettings::unguarded(fn () => InstanceSettings::firstOrCreate(['id' => 0]));
}

/** @return array<string, mixed> */
function run(array $case): array
{
    Server::flushIdentityMap();
    Cache::flush();
    Carbon::setTestNow(Carbon::parse(NOW, 'UTC'));
    // Every queued job is recorded and none runs by itself; the DatabaseStartJob is run below, as a worker would.
    Queue::fake();
    Notification::fake();
    Sleep::fake();
    Event::fake([App\Events\ServiceStatusChanged::class, App\Events\DatabaseStatusChanged::class, App\Events\DatabaseProxyStopped::class, App\Events\FileStorageChanged::class]);

    $engine = $case['engine'];
    $class = MODELS[$engine];
    $team = make(Team::class, ['name' => 'Team', 'personal_team' => false]);
    DB::table('discord_notification_settings')->where('team_id', $team->id)->update(['discord_enabled' => true, 'status_change_discord_notifications' => true]);
    $key = make(PrivateKey::class, ['uuid' => 'key0000000000000000000001', 'name' => 'key', 'team_id' => $team->id, 'private_key' => PRIVATE_KEY]);
    $server = make(Server::class, ['uuid' => 'srv0000000000000000000001', 'team_id' => $team->id, 'private_key_id' => $key->id] + $case['server']);
    $server->settings->forceFill($case['serverSettings'])->save();
    $destination = StandaloneDocker::where('server_id', $server->id)->firstOrFail();
    $destination->forceFill(['uuid' => 'dst0000000000000000000001'] + $case['destination'])->save();
    $project = make(Project::class, ['uuid' => 'prj0000000000000000000001', 'team_id' => $team->id] + $case['project']);
    $environment = $project->environments()->first();
    $environment->forceFill(['uuid' => 'env0000000000000000000001'] + $case['environment'])->save();
    // The created hook adds the engine's data volume(s), as for a database made on the New Resource page.
    $database = make($class, [
        'environment_id' => $environment->id,
        'destination_id' => $destination->id,
        'destination_type' => $destination->getMorphClass(),
    ] + $case['database']);
    // An earlier instant than now, so that a write of last_online_at shows.
    DB::table($database->getTable())->where('id', $database->id)->update(['last_online_at' => LAST_ONLINE_AT]);
    if (array_key_exists('defaultVolumes', $case) && $case['defaultVolumes'] === false) {
        LocalPersistentVolume::where('resource_type', $class)->where('resource_id', $database->id)->delete();
    }

    foreach ($case['sharedVariables'] as $shared) {
        make(SharedEnvironmentVariable::class, [
            'team_id' => $team->id,
            'project_id' => $shared['type'] === 'project' ? $project->id : null,
            'environment_id' => $shared['type'] === 'environment' ? $environment->id : null,
            'server_id' => $shared['type'] === 'server' ? $server->id : null,
        ] + $shared);
    }
    foreach ($case['variables'] as $index => $variable) {
        // Redis's created hook already made REDIS_PASSWORD and REDIS_USERNAME: a case's variable of that name replaces it.
        EnvironmentVariable::where('resourceable_type', $class)->where('resourceable_id', $database->id)->where('key', $variable['key'])->delete();
        $legacy = $variable['uses_legacy_escaping'] ?? null;
        unset($variable['uses_legacy_escaping']);
        $created = EnvironmentVariable::create(['resourceable_type' => $class, 'resourceable_id' => $database->id, 'is_preview' => false, 'order' => $index + 1] + $variable);
        if ($legacy !== null) {
            DB::table('environment_variables')->where('id', $created->id)->update(['uses_legacy_escaping' => $legacy]);
        }
    }
    foreach ($case['persistentStorages'] as $storage) {
        LocalPersistentVolume::create(['resource_type' => $class, 'resource_id' => $database->id] + $storage);
    }
    foreach ($case['fileStorages'] as $index => $storage) {
        $content = $storage['content'] ?? null;
        unset($storage['content']);
        DB::table('local_file_volumes')->insert(['uuid' => 'vol'.str_pad((string) ($index + 1), 21, '0', STR_PAD_LEFT), 'resource_type' => $class, 'resource_id' => $database->id, 'content' => $content === null ? null : encrypt($content, false), 'created_at' => NOW, 'updated_at' => NOW] + $storage);
    }
    if (isset($case['caCertificate'])) {
        make(SslCertificate::class, ['server_id' => $server->id, 'is_ca_certificate' => true, 'common_name' => 'Coolify CA Certificate', 'valid_until' => '2036-11-17 10:11:12'] + $case['caCertificate']);
    }
    if (isset($case['certificate'])) {
        make(SslCertificate::class, ['server_id' => $server->id, 'resource_type' => $class, 'resource_id' => $database->id, 'is_ca_certificate' => false, 'common_name' => $database->uuid, 'valid_until' => '2027-11-20 10:11:12'] + $case['certificate']);
    }
    $given = SslCertificate::pluck('id')->all();

    $processes = [];
    $matched = [];
    Process::fake(function (PendingProcess $process) use (&$processes, &$matched, $case) {
        $script = remoteScript($process);
        if ($script === null) {
            return Process::result();
        }
        $answer = ['output' => '', 'errorOutput' => '', 'exitCode' => 0];
        foreach ($case['responses'] as $index => $rule) {
            if (! str_contains($script, $rule['match'])) {
                continue;
            }
            $matched[$index] = ($matched[$index] ?? 0) + 1;
            $given = isset($rule['sequence']) ? ($rule['sequence'][$matched[$index] - 1] ?? end($rule['sequence'])) : $rule;
            $answer = array_merge($answer, array_intersect_key($given, $answer));
            break;
        }
        $processes[] = ['script' => $script] + array_filter($answer, fn ($value) => $value !== '' && $value !== 0);

        return Process::result(output: $answer['output'], errorOutput: $answer['errorOutput'], exitCode: $answer['exitCode']);
    });

    $thrown = null;
    $result = null;
    $database = $class::findOrFail($database->id);
    try {
        $result = match ($case['action']) {
            'start' => StartDatabase::run($database),
            'restart' => RestartDatabase::run($database),
            'stop' => StopDatabase::run($database, false, $case['dockerCleanup'] ?? true),
            'proxy-start' => StartDatabaseProxy::run($database),
            'proxy-stop' => StopDatabaseProxy::run($database),
        };
    } catch (Throwable $e) {
        $thrown = get_class($e).': '.$e->getMessage();
    }

    // The queue worker's part: the queued DatabaseStartJob runs once ($tries = 1), and failed() when it throws.
    $jobThrown = null;
    foreach (Queue::pushed(DatabaseStartJob::class) as $job) {
        try {
            $job->handle();
        } catch (Throwable $e) {
            $jobThrown = get_class($e).': '.$e->getMessage();
            $job->failed($e);
        }
    }

    // The generated certificate texts, and their masks.
    $masks = [];
    $generated = [];
    $ca = SslCertificate::where('server_id', $server->id)->where('is_ca_certificate', true)->whereNotIn('id', $given)->first();
    if ($ca) {
        $masks[$ca->ssl_certificate] = '{{generated:ca-certificate}}';
        $masks[$ca->ssl_private_key] = '{{generated:ca-private-key}}';
        $generated['ca'] = certificateFacts($ca);
    }
    $leaf = SslCertificate::where('resource_type', $class)->where('resource_id', $database->id)->whereNotIn('id', $given)->first();
    if ($leaf) {
        $masks[$leaf->ssl_certificate."\n".$leaf->ssl_private_key] = '{{generated:certificate-and-key}}';
        $masks[$leaf->ssl_certificate] = '{{generated:certificate}}';
        $masks[$leaf->ssl_private_key] = '{{generated:private-key}}';
        $generated['certificate'] = certificateFacts($leaf);
    }
    $mask = function (?string $text) use ($masks): ?string {
        if ($text === null) {
            return null;
        }
        foreach ($masks as $secret => $name) {
            $text = str_replace([base64_encode($secret), $secret], $name, $text);
        }

        return $text;
    };
    foreach ($processes as $index => $process) {
        $processes[$index]['script'] = $mask($process['script']);
    }

    $row = DB::table((new $class)->getTable())->where('id', $database->id)->first();
    $activity = Activity::query()->orderByDesc('id')->first();
    $sleeps = (function () {
        return array_map(fn ($interval) => $interval->totalSeconds, static::$sequence);
    })->bindTo(null, Sleep::class)();

    return [
        'result' => $result instanceof Activity ? ['activity' => true] : $result,
        'thrown' => $thrown,
        'jobThrown' => $jobThrown,
        'processes' => $processes,
        'activity' => $activity === null ? null : [
            'status' => data_get($activity, 'properties.status'),
            'exitCode' => data_get($activity, 'properties.exitCode'),
            'error' => data_get($activity, 'properties.error'),
            'operation' => data_get($activity, 'properties.operation'),
            'log' => array_map(fn ($entry) => ['type' => $entry['type'], 'output' => $entry['output']], json_decode($activity->description ?: '[]', true, flags: JSON_THROW_ON_ERROR)),
        ],
        'database' => [
            'status' => $row->status,
            'started_at' => $row->started_at,
            'last_online_at' => $row->last_online_at,
            'is_public' => (bool) $row->is_public,
            'restart_count' => $row->restart_count ?? null,
            'last_restart_at' => $row->last_restart_at ?? null,
            'last_restart_type' => $row->last_restart_type ?? null,
        ] + (isset(CONF_COLUMNS[$engine]) ? ['conf' => $row->{CONF_COLUMNS[$engine]}] : []),
        'certificates' => SslCertificate::orderBy('id')->get()->map(fn ($c) => [
            'given' => in_array($c->id, $given, true),
            'is_ca_certificate' => (bool) $c->is_ca_certificate,
            'resource' => $c->resource_type === null ? null : 'database',
            'common_name' => $c->common_name,
            'subject_alternative_names' => $c->subject_alternative_names,
            'configuration_dir' => $c->configuration_dir,
            'mount_path' => $c->mount_path,
            'valid_until' => $c->valid_until?->toJSON(),
        ])->all(),
        'fileStorages' => DB::table('local_file_volumes')->where('resource_type', $class)->where('resource_id', $database->id)->orderBy('id')->get()->map(fn ($f) => [
            'fs_path' => $f->fs_path,
            'mount_path' => $f->mount_path,
            'content' => $f->content === null ? null : $mask(decrypt($f->content, false)),
            'is_directory' => (bool) $f->is_directory,
            'chmod' => $f->chmod,
            'chown' => $f->chown,
        ])->all(),
        'variables' => EnvironmentVariable::where('resourceable_type', $class)->where('resourceable_id', $database->id)->orderBy('id')->get()->map(fn ($v) => ['key' => $v->key, 'value' => $v->value])->all(),
        'generated' => $generated === [] ? null : $generated,
        'sleeps' => $sleeps,
        'notifications' => sentNotifications(),
        'jobs' => pushedJobs(),
        'events' => dispatchedEvents(),
    ];
}

/** What can be said of a generated certificate: its names, how long it is valid, its key's curve and its signature. */
function certificateFacts(SslCertificate $certificate): array
{
    $parsed = openssl_x509_parse($certificate->ssl_certificate);
    $key = openssl_pkey_get_details(openssl_pkey_get_private($certificate->ssl_private_key));

    return [
        'subject' => $parsed['subject'],
        'issuer' => $parsed['issuer'],
        'subjectAltName' => $parsed['extensions']['subjectAltName'] ?? null,
        'basicConstraints' => $parsed['extensions']['basicConstraints'] ?? null,
        // OpenSSL signs at the real time, not at the instant the run stands still at: only the length is told.
        'validDays' => intdiv($parsed['validTo_time_t'] - $parsed['validFrom_time_t'], 86400),
        'curve' => $key['ec']['curve_name'] ?? null,
        'signature' => $parsed['signatureTypeSN'],
    ];
}

/** @return list<string> The notification classes that Coolify sent, by name. */
function sentNotifications(): array
{
    $names = [];
    foreach ((fn () => $this->notifications)->call(Notification::getFacadeRoot()) as $byNotifiable) {
        foreach ($byNotifiable as $byKey) {
            foreach ($byKey as $class => $sent) {
                foreach ($sent as $_) {
                    $names[] = class_basename($class);
                }
            }
        }
    }

    return $names;
}

/** @return list<string> The other jobs the action queued (faked, so none ran), by name. */
function pushedJobs(): array
{
    $names = [];
    foreach (Queue::pushedJobs() as $class => $pushed) {
        foreach ($pushed as $entry) {
            $job = $entry['job'];
            $names[] = method_exists($job, 'displayName') ? class_basename($job->displayName()) : class_basename($class);
        }
    }

    return $names;
}

/** @return list<string> The faked broadcast events that were dispatched, by name. */
function dispatchedEvents(): array
{
    $names = [];
    foreach ((fn () => $this->events)->call(Event::getFacadeRoot()) as $class => $dispatched) {
        foreach ($dispatched as $_) {
            $names[] = class_basename($class);
        }
    }

    return $names;
}

$file = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR);
// A value "@text:<name>" stands for a long text of `texts` (a certificate, a key).
$file['runs'] = eachString($file['runs'], fn (string $text) => str_starts_with($text, '@text:') ? $file['texts'][substr($text, 6)] : $text);
$out = ['now' => Carbon::parse(NOW, 'UTC')->toJSON(), 'runs' => []];
migrateFresh();
foreach ($file['runs'] as $case) {
    if (! str_starts_with($case['id'], $only)) {
        continue;
    }
    $full = merged($file['defaults'], $case);
    // A case's responses are asked first; the defaults answer what it leaves.
    $full['responses'] = array_merge($case['responses'] ?? [], $file['defaults']['responses']);
    // Every run starts from the same empty database: its rows, and the ids they got, are rolled back.
    DB::beginTransaction();
    try {
        $out['runs'][$case['id']] = run($full);
    } catch (Throwable $e) {
        // A case that Coolify's models refuse to store never reaches an action.
        fwrite(STDERR, "{$case['id']}: ".get_class($e).': '.$e->getMessage()."\n".$e->getTraceAsString()."\n");
        exit(1);
    } finally {
        DB::rollBack();
    }
}

/** Every string of $value, counted (first pass) or replaced by its reference (second pass). */
function eachString(mixed $value, Closure $fn): mixed
{
    if (is_string($value)) {
        return $fn($value);
    }
    if (is_array($value)) {
        foreach ($value as $key => $item) {
            $value[$key] = eachString($item, $fn);
        }
    }

    return $value;
}

$seen = [];
eachString($out, function (string $text) use (&$seen) {
    if (strlen($text) >= 150) {
        $seen[$text] = ($seen[$text] ?? 0) + 1;
    }

    return $text;
});
$strings = array_keys(array_filter($seen, fn (int $count) => $count > 1));
$index = array_flip($strings);
$out = ['now' => $out['now'], 'strings' => $strings] + eachString($out, fn (string $text) => isset($index[$text]) ? ['$string' => $index[$text]] : $text);
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION), "\n";
