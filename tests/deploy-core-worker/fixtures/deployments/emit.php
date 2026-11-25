<?php
// Runs Coolify's own deployment code (coollabsio/coolify@91b7e3e, Apache-2.0) over cases.json and
// prints goldens.json — nothing here is a port. Docker image deployments (DP-56) and the builds on the
// server: a Dockerfile in a public repository, a pasted Dockerfile, Nixpacks, a static site (DP-61). Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// The application is booted as Coolify's own test suite boots it: the `testing` connection (SQLite
// in memory), the schema of database/schema/testing-schema.sql and every later migration. Each run
// builds its team, server, destination, project, environment and application as real models, queues
// a deployment with queue_application_deployment() and lets the sync queue run the real
// ApplicationDeploymentJob. No server is contacted: Process::fake() answers every SSH process with
// what the case scripts, and records the script it was given. Sleep, notifications, the other queued
// jobs and the two broadcast events are faked with Laravel's own fakes, and time stands still.
//
// Output:
//   { "now":       the instant every run stands still at,
//     "runs":      { "<case id>": { processes, deployment, application, build, sleeps, notifications, jobs, thrown, result
//                                   [, lines, linesAll: for a case with "view": true] } },
//     "functions": { "<case id>": { "ok": true, "value": … } | { "ok": false, "error": "<class>: <message>" } } }
//
// To keep the file small, a process leaves out `input` when it has none, `output` and `errorOutput` when empty
// and `exitCode` when 0; a log entry leaves out `command` when null, `type` when "stdout", `hidden` when false
// and `batch` when 1, and never carries `timestamp` (always `now`) or `order` (its position, from 1). A string
// of 150 characters or more that occurs more than once — the helper's commands, a compose file written twice —
// is written once in `strings` and stands as { "$string": <its index> } where it occurs.

use App\Actions\CoolifyTask\RunRemoteProcess;
use App\Jobs\ApplicationDeploymentJob;
use App\Models\Application;
use App\Models\ApplicationDeploymentQueue;
use App\Models\Environment;
use App\Models\EnvironmentVariable;
use App\Models\InstanceSettings;
use App\Models\LocalFileVolume;
use App\Models\LocalPersistentVolume;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\Server;
use App\Models\SharedEnvironmentVariable;
use App\Models\StandaloneDocker;
use App\Models\Team;
use App\Services\Security\SensitiveDataRedactor;
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
use Symfony\Component\Yaml\Yaml;

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

$scratch = sys_get_temp_dir().'/freeploy-deployment-goldens-'.getmypid();
@mkdir($scratch, 0700, true);
config([
    // One SSH process per command batch, as on a server without connection sharing.
    'constants.ssh.mux_enabled' => false,
    'filesystems.disks.ssh-keys.root' => $scratch.'/keys',
    'filesystems.disks.ssh-mux.root' => $scratch.'/mux',
    'broadcasting.default' => 'null',
    'queue.default' => 'sync',
    'cache.default' => 'array',
]);

const NOW = '2026-11-20 10:11:12';
// The ed25519 test key of the SSH key fixtures; the goldens do not depend on its content.
define('PRIVATE_KEY', file_get_contents(__DIR__.'/../ssh-keys/ed25519.openssh'));

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
 * (SshMultiplexingHelper::generateSshBatchCommand), or one remote command with content on its stdin
 * (generateSshStdinCommand). Null for the host key probe, which runs no command on the server.
 *
 * @return array{script: string, input: ?string}|null
 */
function remoteSide(PendingProcess $process): ?array
{
    $command = is_array($process->command) ? implode(' ', $process->command) : (string) $process->command;
    $input = is_string($process->input) ? $process->input : null;
    if (str_ends_with($command, "exec bash -se; else exec sh -se; fi\"'")) {
        // sshBatchInput() ends the batch with one line break.
        return ['script' => substr((string) $input, 0, -strlen(PHP_EOL)), 'input' => null];
    }
    if (preg_match("/ -- '[^']*'@'[^']*' (.*)\\z/s", $command, $match) !== 1) {
        throw new RuntimeException("Not an SSH process: {$command}");
    }
    if ($match[1] === 'true') {
        return null;
    }
    if (! str_starts_with($match[1], "'") || ! str_ends_with($match[1], "'")) {
        throw new RuntimeException("Not a quoted remote command: {$match[1]}");
    }

    return ['script' => str_replace("'\\''", "'", substr($match[1], 1, -1)), 'input' => $input];
}

function migrateFresh(): void
{
    Artisan::call('migrate:fresh', ['--force' => true]);
    InstanceSettings::unguarded(fn () => InstanceSettings::firstOrCreate(['id' => 0]));
    // The source of a public repository, as Coolify's GithubAppSeeder creates it: id 0, for every team.
    make(App\Models\GithubApp::class, ['id' => 0, 'uuid' => 'github-public', 'name' => 'Public GitHub', 'api_url' => 'https://api.github.com', 'html_url' => 'https://github.com', 'is_public' => true, 'team_id' => 0]);
}

/** @return array<string, mixed> */
function run(array $case): array
{
    Server::flushIdentityMap();
    Cache::flush();
    Carbon::setTestNow(Carbon::parse(NOW, 'UTC'));
    // The batch number of a log entry counts execute_remote_command() calls of the worker process: from zero here.
    ApplicationDeploymentJob::$batch_counter = 0;
    Queue::fake()->except([ApplicationDeploymentJob::class]);
    Notification::fake();
    Sleep::fake();
    Event::fake([App\Events\ServiceStatusChanged::class, App\Events\ApplicationConfigurationChanged::class]);

    $team = make(Team::class, ['name' => 'Team', 'personal_team' => false] + ($case['team'] ?? []));
    // One channel on, so that Notification::fake() records what Coolify would send.
    DB::table('discord_notification_settings')->where('team_id', $team->id)->update(['discord_enabled' => true, 'deployment_success_discord_notifications' => true, 'deployment_failure_discord_notifications' => true]);
    $key = make(PrivateKey::class, ['uuid' => 'key0000000000000000000001', 'name' => 'key', 'team_id' => $team->id, 'private_key' => PRIVATE_KEY]);
    $server = make(Server::class, ['uuid' => 'srv0000000000000000000001', 'team_id' => $team->id, 'private_key_id' => $key->id] + $case['server']);
    $server->settings->forceFill($case['serverSettings'])->save();
    $destination = StandaloneDocker::where('server_id', $server->id)->firstOrFail();
    $destination->forceFill(['uuid' => 'dst0000000000000000000001'] + $case['destination'])->save();
    $project = make(Project::class, ['uuid' => 'prj0000000000000000000001', 'team_id' => $team->id] + $case['project']);
    $environment = $project->environments()->first();
    $environment->forceFill(['uuid' => 'env0000000000000000000001'] + $case['environment'])->save();
    $application = make(Application::class, [
        'environment_id' => $environment->id,
        'destination_id' => $destination->id,
        'destination_type' => $destination->getMorphClass(),
    ] + $case['application']);
    $application->settings->forceFill($case['settings'])->save();

    foreach ($case['sharedVariables'] as $shared) {
        make(SharedEnvironmentVariable::class, [
            'team_id' => $team->id,
            'project_id' => $shared['type'] === 'project' ? $project->id : null,
            'environment_id' => $shared['type'] === 'environment' ? $environment->id : null,
            'server_id' => $shared['type'] === 'server' ? $server->id : null,
        ] + $shared);
    }
    foreach ($case['variables'] as $index => $variable) {
        // A name that new variables cannot use (saved by an older version): stored past the model's check.
        $storedKey = $variable['stored_key'] ?? null;
        unset($variable['stored_key']);
        $created = EnvironmentVariable::create(['resourceable_type' => Application::class, 'resourceable_id' => $application->id, 'is_preview' => false, 'order' => $index + 1] + $variable);
        if ($storedKey !== null) {
            DB::table('environment_variables')->where('id', $created->id)->update(['key' => $storedKey]);
        }
    }
    foreach ($case['persistentStorages'] as $storage) {
        LocalPersistentVolume::create(['resource_type' => Application::class, 'resource_id' => $application->id] + $storage);
    }
    foreach ($case['fileStorages'] as $storage) {
        DB::table('local_file_volumes')->insert(['uuid' => 'vol'.str_pad((string) (count($case['fileStorages'])), 21, '0', STR_PAD_LEFT), 'resource_type' => Application::class, 'resource_id' => $application->id, 'created_at' => NOW, 'updated_at' => NOW] + $storage);
    }
    foreach ($case['earlierDeployments'] ?? [] as $earlier) {
        // "configuration_snapshot": "current" — the deployment stored the configuration the application has now.
        if (($earlier['configuration_snapshot'] ?? null) === 'current') {
            $earlier['configuration_snapshot'] = $application->fresh()->deploymentConfigurationSnapshot();
        }
        make(ApplicationDeploymentQueue::class, $earlier + ['application_id' => $application->id, 'server_id' => $server->id, 'destination_id' => $destination->id]);
    }
    // What the user changed since the last deployment.
    if (isset($case['changedSince']['application'])) {
        $application->forceFill($case['changedSince']['application'])->save();
    }
    if (isset($case['changedSince']['settings'])) {
        $application->settings->forceFill($case['changedSince']['settings'])->save();
    }
    // What should_skip_build() asks when the image of the commit exists: computed here, before the job changes anything.
    $pendingDiff = $application->fresh()->pendingDeploymentConfigurationDiff();
    $variableKeysBefore = DB::table('environment_variables')->where('resourceable_id', $application->id)->orderBy('id')->pluck('key')->all();
    // The rows a build reads, as they are stored (after the models' mutators and creating hooks), before the job runs.
    $buildRow = (array) DB::table('applications')->where('id', $application->id)->first(['git_repository', 'git_commit_sha', 'base_directory', 'publish_directory', 'dockerfile', 'dockerfile_location', 'install_command', 'build_command', 'start_command', 'static_image', 'custom_nginx_configuration', 'source_id', 'source_type', 'private_key_id', 'custom_healthcheck_found', 'git_ssh_known_hosts']);
    $buildSettings = (array) DB::table('application_settings')->where('application_id', $application->id)->first(['is_static', 'is_spa', 'is_git_submodules_enabled', 'is_git_lfs_enabled', 'is_git_shallow_clone_enabled', 'disable_build_cache', 'inject_build_args_to_dockerfile', 'include_source_commit_in_build', 'is_build_server_enabled', 'is_preserve_repository_enabled', 'include_network_hosts_in_build']);
    // The application's variables in the order the job reads them (orderEnvironmentVariables), with the ids they were created with.
    $variablesQuery = $application->fresh()->environment_variables();
    $variablesBefore = ($application->settings->fresh()->is_env_sorting_enabled ? $variablesQuery->orderBy('key') : $variablesQuery->orderBy('order')->orderBy('id'))->get()
        ->map(fn ($v) => ['id' => $v->id, 'key' => $v->key, 'value' => $v->value, 'is_literal' => (bool) $v->is_literal, 'is_multiline' => (bool) $v->is_multiline, 'is_runtime' => (bool) $v->is_runtime, 'is_buildtime' => (bool) $v->is_buildtime])->all();

    $processes = [];
    $matched = [];
    $cancelled = false;
    Process::fake(function (PendingProcess $process) use (&$processes, &$matched, &$cancelled, $case) {
        $remote = remoteSide($process);
        if ($remote === null) {
            return Process::result();
        }
        $answer = ['output' => '', 'errorOutput' => '', 'exitCode' => 0];
        foreach ($case['responses'] as $index => $rule) {
            if (! str_contains($remote['script'], $rule['match'])) {
                continue;
            }
            $matched[$index] = ($matched[$index] ?? 0) + 1;
            $given = isset($rule['sequence']) ? ($rule['sequence'][$matched[$index] - 1] ?? end($rule['sequence'])) : $rule;
            $answer = array_merge($answer, array_intersect_key($given, $answer));
            break;
        }
        // The user's cancel (DeploymentNavbar::cancel) as the job sees it: the status changes while a command runs.
        if (! $cancelled && isset($case['cancelOn']) && str_contains($remote['script'], $case['cancelOn'])) {
            $cancelled = true;
            DB::table('application_deployment_queues')->where('deployment_uuid', $case['deployment']['deployment_uuid'])->update(['status' => 'cancelled-by-user']);
        }
        $processes[] = array_filter($remote, fn ($value) => $value !== null) + array_filter($answer, fn ($value) => $value !== '' && $value !== 0);

        return Process::result(output: $answer['output'], errorOutput: $answer['errorOutput'], exitCode: $answer['exitCode']);
    });

    $thrown = null;
    $result = null;
    try {
        $result = queue_application_deployment(...(['application' => $application->fresh()] + $case['deployment']));
    } catch (Throwable $e) {
        $thrown = get_class($e).': '.$e->getMessage();
    }

    $deployment = DB::table('application_deployment_queues')->where('deployment_uuid', $case['deployment']['deployment_uuid'])->first();
    $applicationRow = DB::table('applications')->where('id', $application->id)->first();
    $sleeps = (function () {
        return array_map(fn ($interval) => $interval->totalSeconds, static::$sequence);
    })->bindTo(null, Sleep::class)();

    return [
        'uuids' => ['application' => $application->uuid],
        'result' => $result === null ? null : array_intersect_key($result, array_flip(['status', 'message', 'deployment_uuid'])),
        'thrown' => $thrown,
        'processes' => $processes,
        'deployment' => $deployment === null ? null : [
            'status' => $deployment->status,
            'logs' => $deployment->logs === null ? null : compactLogs(json_decode($deployment->logs, true, flags: JSON_THROW_ON_ERROR)),
            'finished_at' => $deployment->finished_at,
            'deploy_started_at' => $deployment->deploy_started_at,
            'build_server_id' => $deployment->build_server_id,
            'commit' => $deployment->commit,
            'deployment_url' => $deployment->deployment_url,
            'application_name' => $deployment->application_name,
            'server_name' => $deployment->server_name,
            'commit_message' => $deployment->commit_message,
            'force_rebuild' => (bool) $deployment->force_rebuild,
            'restart_only' => (bool) $deployment->restart_only,
            'rollback' => (bool) $deployment->rollback,
        ],
        'application' => [
            'status' => $applicationRow->status,
            'custom_labels' => $applicationRow->custom_labels,
            'restart_count' => $applicationRow->restart_count,
            'last_restart_at' => $applicationRow->last_restart_at,
            'last_restart_type' => $applicationRow->last_restart_type,
            'restart_limit_reached' => (bool) $applicationRow->restart_limit_reached,
        ],
        // What a build reads and writes beside that (DP-61).
        'build' => [
            'configurationDiff' => ['legacyFallback' => $pendingDiff->isLegacyFallback(), 'requiresBuild' => $pendingDiff->requiresBuild()],
            'row' => $buildRow + $buildSettings,
            'variables' => $variablesBefore,
            'health_check_enabled' => (bool) $applicationRow->health_check_enabled,
            'health_check_interval' => $applicationRow->health_check_interval,
            'health_check_timeout' => $applicationRow->health_check_timeout,
            'health_check_retries' => $applicationRow->health_check_retries,
            'health_check_start_period' => $applicationRow->health_check_start_period,
            'custom_healthcheck_found' => (bool) $applicationRow->custom_healthcheck_found,
            'git_ssh_known_hosts' => $applicationRow->git_ssh_known_hosts,
            // The variables the job created (Laravel's two Nixpacks variables), with their values.
            'createdVariables' => EnvironmentVariable::where('resourceable_id', $application->id)->orderBy('id')->get()->slice(count($variableKeysBefore))->map(fn ($v) => ['key' => $v->key, 'value' => $v->value, 'is_preview' => (bool) $v->is_preview])->values()->all(),
        ],
        'otherDeployments' => DB::table('application_deployment_queues')->where('deployment_uuid', '!=', $case['deployment']['deployment_uuid'])->orderBy('id')->get(['deployment_uuid', 'status'])->map(fn ($row) => (array) $row)->all(),
        'sleeps' => $sleeps,
        'notifications' => sentNotifications(),
        'jobs' => pushedJobs(),
    ] + (empty($case['view']) ? [] : [
        // The lines the deployment page shows (decode_remote_command_output): without the debug lines, and with them.
        'lines' => decode_remote_command_output(ApplicationDeploymentQueue::where('deployment_uuid', $case['deployment']['deployment_uuid'])->first())->values()->all(),
        'linesAll' => decode_remote_command_output(ApplicationDeploymentQueue::where('deployment_uuid', $case['deployment']['deployment_uuid'])->first(), includeAll: true)->values()->all(),
    ]);
}

/** The stored log entries without what is the same in every entry (see the head of this file). */
function compactLogs(array $logs): array
{
    $expected = Carbon::parse(NOW, 'UTC')->toJSON();
    foreach ($logs as $index => $entry) {
        if ($entry['order'] !== $index + 1 || $entry['timestamp'] !== $expected || array_keys($entry) !== ['command', 'output', 'type', 'timestamp', 'hidden', 'batch', 'order']) {
            throw new RuntimeException('A log entry is not what compactLogs() expects: '.json_encode($entry));
        }
        unset($entry['order'], $entry['timestamp']);
        $logs[$index] = array_filter($entry, fn ($value, $key) => $value !== ['command' => null, 'type' => 'stdout', 'hidden' => false, 'batch' => 1, 'output' => INF][$key], ARRAY_FILTER_USE_BOTH);
    }

    return $logs;
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

/** @return list<string> The other jobs the deployment queued (faked, so none ran), by name. */
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

function fn_case(array $case): mixed
{
    $args = $case['args'];
    switch ($case['fn']) {
        case 'yamlDump':
            // What generate_compose_file() calls for its array.
            return Yaml::dump($args[0], 10);
        case 'convertDockerRunToCompose':
            return convertDockerRunToCompose(...$args);
        case 'unsupportedDockerRunOptions':
            return unsupportedDockerRunOptions(...$args);
        case 'seccompProfileMountFlags':
            return seccompProfileMountFlags(...$args);
        case 'escapeComposeEnvFileValue':
            return escapeComposeEnvFileValue(...$args);
        case 'redactText':
            return app(SensitiveDataRedactor::class)->redactText(...$args);
        case 'takeCompleteOutput':
            $pending = $args[0];
            $taken = RunRemoteProcess::takeCompleteOutput($pending, $args[1] ?? false);

            return ['taken' => $taken, 'pending' => $pending];
        case 'gitSshSetupCommand':
            return gitSshSetupCommand(...$args);
        case 'dockerStopCommand':
            return dockerStopCommand(...$args);
        case 'escapeshellarg':
            return escapeshellarg(...$args);
        case 'parseGpuOptions':
            return App\Models\ApplicationSetting::parseGpuOptions(...$args);
        case 'generate_readme_file':
            return generate_readme_file(...$args);
        default:
            throw new RuntimeException("Unknown function {$case['fn']}");
    }
}

$file = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR);
$out = ['now' => Carbon::parse(NOW, 'UTC')->toJSON(), 'runs' => [], 'functions' => []];
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
        // A case that Coolify's models refuse to store never reaches a deployment.
        fwrite(STDERR, "{$case['id']}: ".get_class($e).': '.$e->getMessage()."\n");
        exit(1);
    } finally {
        DB::rollBack();
    }
}
foreach ($file['functions'] as $case) {
    if (! str_starts_with($case['id'], $only)) {
        continue;
    }
    try {
        $out['functions'][$case['id']] = ['ok' => true, 'value' => fn_case($case)];
    } catch (Throwable $e) {
        $out['functions'][$case['id']] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
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
