<?php
// Edits the Compose file of one-click services through Coolify's own "Edit Compose file" and prints what its
// parser made of the edited file — Coolify's own code (coollabsio/coolify@91b7e3e, Apache-2.0), nothing here
// is a port. Usage (see README.md):
//
//   php emit-reparse.php <coolify root with vendor/ and a .env> <catalogue json> <reparse-cases.json> > reparse-goldens.json
//
// The fixture, the creation and what is fixed or random are emit.php's. Per case: the service is created
// from its template as Resource/Create.php creates it (-> "before"), then the case's replacements are
// applied to its docker_compose_raw and the edited text is saved the way the page saves it:
// Livewire::test(StackForm::class)->call('saveCompose', $raw), as the team's owner — StackForm::submit()
// with the fields its mount() loaded: validateDockerComposeForInjection(), save(), saveExtraFields(),
// parse(), ensureDockerComposeAccepted() (skipped: the server is not functional), saveComposeConfigs()
// (its SSH commands are faked) (-> "after", with the events the component dispatched).
// SQLite in memory with all migrations; each case runs in a transaction that is rolled back.

use App\Livewire\Project\Service\StackForm;
use App\Models\Environment;
use App\Models\InstanceSettings;
use App\Models\Project;
use App\Models\Server;
use App\Models\Service;
use App\Models\ServiceApplication;
use App\Models\ServiceDatabase;
use App\Models\StandaloneDocker;
use App\Models\Team;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Queue;
use Livewire\Livewire;

[$_, $root, $catalogueFile, $casesFile] = $argv;
// Nothing is written into the Coolify copy: no log files, and the SSH key below goes to a temporary directory.
foreach (['DB_CONNECTION' => 'testing', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array', 'LOG_CHANNEL' => 'null'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$keys = sys_get_temp_dir().'/emit-reparse-keys-'.getmypid();
config(['filesystems.disks.ssh-keys.root' => $keys, 'constants.ssh.mux_enabled' => false]);
register_shutdown_function(fn () => is_dir($keys) && array_map('unlink', glob("$keys/*")) && rmdir($keys));
Artisan::call('migrate', ['--force' => true]);
// The component renders its view: no built assets, as the tests' withoutVite().
Illuminate\Support\Facades\Vite::clearResolvedInstance();
$app->instance(Illuminate\Foundation\Vite::class, new class extends Illuminate\Foundation\Vite
{
    public function __invoke($entrypoints, $buildDirectory = null)
    {
        return new Illuminate\Support\HtmlString('');
    }

    public function __call($method, $parameters)
    {
        return '';
    }

    public function __toString()
    {
        return '';
    }
});
Bus::fake();
Queue::fake();
// saveComposeConfigs() writes the files over SSH: every process "succeeds" without running.
Process::fake();
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
\Carbon\CarbonImmutable::setTestNow(\Carbon\CarbonImmutable::parse('2026-01-01T00:00:00Z'));

const SERVICE_UUID = 'svc0uuid0000000000000001';
$subCounter = 0;
$subUuid = function ($model) use (&$subCounter) {
    $subCounter++;
    $model->uuid = sprintf('sub%021d', $subCounter);
};
ServiceApplication::creating($subUuid);
ServiceDatabase::creating($subUuid);

InstanceSettings::forceCreate(['id' => 0]);
$team = Team::forceCreate(['name' => 'Fixture Team', 'personal_team' => false, 'show_boarding' => false]);
$owner = User::forceCreate(['name' => 'Fixture Owner', 'email' => 'owner@example.com', 'password' => bcrypt('password')]);
$team->members()->attach($owner, ['role' => 'owner']);
// A key, so that saveComposeConfigs() can build its SSH commands (which Process::fake() then answers).
$privateKey = App\Models\PrivateKey::forceCreate(['name' => 'fixture-key', 'team_id' => $team->id, 'private_key' => phpseclib3\Crypt\EC::createKey('Ed25519')->toString('OpenSSH')]);
$server = Server::forceCreate(['uuid' => 'srv0uuid0000000000000001', 'name' => 'fixture-server', 'ip' => '203.0.113.10', 'team_id' => $team->id, 'private_key_id' => $privateKey->id]);
$destination = StandaloneDocker::where('server_id', $server->id)->firstOrFail();
$project = Project::forceCreate(['uuid' => 'prj0uuid0000000000000001', 'name' => 'Fixture Project', 'team_id' => $team->id]);
$environment = Environment::where('project_id', $project->id)->firstOrFail();
Auth::login($owner->fresh());
session(['currentTeam' => $team->fresh()]);

/** StackForm, recording the toasts it dispatches (the success, error and warning messages the page shows). */
class RecordingStackForm extends StackForm
{
    public array $emitted = [];

    public function dispatch($event, ...$params)
    {
        if (in_array($event, ['success', 'error', 'warning'], true)) {
            $this->emitted[] = [$event, $params[0] ?? null];
        }

        return parent::dispatch($event, ...$params);
    }
}

const SKIP = ['created_at', 'updated_at', 'deleted_at', 'last_online_at'];

function rows(string $table, array $where, array $encrypted = []): array
{
    $query = DB::table($table)->orderBy('id');
    foreach ($where as $column => $value) {
        is_array($value) ? $query->whereIn($column, $value) : $query->where($column, $value);
    }

    return $query->get()->map(function ($row) use ($encrypted) {
        $row = (array) $row;
        foreach (SKIP as $column) {
            unset($row[$column]);
        }
        foreach ($encrypted as $column) {
            if (isset($row[$column])) {
                $row[$column] = $column === 'value' ? Crypt::decrypt($row[$column]) : Crypt::decryptString($row[$column]);
            }
        }

        return $row;
    })->all();
}

function state(Service $service): array
{
    $applicationIds = DB::table('service_applications')->where('service_id', $service->id)->pluck('id')->all();
    $databaseIds = DB::table('service_databases')->where('service_id', $service->id)->pluck('id')->all();
    $partsOf = function (string $table, array $extra = []) use ($applicationIds, $databaseIds) {
        $rows = array_merge(
            rows($table, ['resource_type' => ServiceApplication::class, 'resource_id' => $applicationIds], $extra),
            rows($table, ['resource_type' => ServiceDatabase::class, 'resource_id' => $databaseIds], $extra),
        );
        usort($rows, fn ($a, $b) => $a['id'] <=> $b['id']);

        return array_map(fn ($row) => array_diff_key($row, ['uuid' => 1]), $rows);
    };

    return [
        'service' => rows('services', ['id' => $service->id])[0],
        'applications' => rows('service_applications', ['service_id' => $service->id]),
        'databases' => rows('service_databases', ['service_id' => $service->id]),
        'environment_variables' => array_map(fn ($row) => array_diff_key($row, ['uuid' => 1]), rows('environment_variables', ['resourceable_type' => Service::class, 'resourceable_id' => $service->id], ['value'])),
        'persistent_volumes' => $partsOf('local_persistent_volumes'),
        'file_volumes' => $partsOf('local_file_volumes', ['content']),
    ];
}

/** Each replacement must find its text: once, or at least once with `all`. */
function edited(string $raw, array $replacements): string
{
    foreach ($replacements as $replacement) {
        $count = substr_count($raw, $replacement['search']);
        if ($count === 0 || ($count > 1 && empty($replacement['all']))) {
            throw new RuntimeException("The replacement's text occurs $count times.");
        }
        $raw = str_replace($replacement['search'], $replacement['replace'], $raw);
    }

    return $raw;
}

$templates = json_decode(file_get_contents($catalogueFile));
$cases = json_decode(file_get_contents($casesFile), true)['cases'];
$fixture = [
    'coolify_version' => config('constants.coolify.version'),
    'service_uuid' => SERVICE_UUID,
    'server' => ['ip' => $server->ip, 'wildcard_domain' => $server->settings->wildcard_domain, 'proxy_type' => $server->proxyType(), 'generate_exact_labels' => (bool) $server->settings->generate_exact_labels, 'traefik_certificate_resolver' => $server->traefikCertificateResolver(), 'is_traffic_analytics_enabled' => $server->isTrafficAnalyticsEnabled(), 'caddy_supports_log_append' => $server->caddySupportsLogAppend(), 'is_log_drain_enabled' => (bool) $server->isLogDrainEnabled(), 'is_functional' => $server->isFunctional()],
    'destination' => ['network' => $destination->network],
    'project' => ['name' => $project->name],
    'environment' => ['name' => $environment->name],
    'base_configuration_dir' => base_configuration_dir(),
];
$out = ['fixture' => $fixture, 'cases' => []];

foreach ($cases as $case) {
    $name = $case['template'];
    $template = $templates->{$name};
    $subCounter = 0;
    DB::beginTransaction();
    try {
        // Resource/Create.php::createResource, as emit.php.
        $oneClickDotEnvs = data_get($template, 'envs', null);
        if ($oneClickDotEnvs) {
            $oneClickDotEnvs = str(base64_decode($oneClickDotEnvs))->split('/\r\n|\r|\n/')->filter(fn ($value) => ! empty($value));
        }
        $payload = [
            'docker_compose_raw' => base64_decode(data_get($template, 'compose')),
            'environment_id' => $environment->id,
            'service_type' => $name,
            'server_id' => $destination->server_id,
            'destination_id' => $destination->id,
            'destination_type' => $destination->getMorphClass(),
        ];
        if (in_array($name, NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK)) {
            data_set($payload, 'connect_to_docker_network', true);
        }
        $service = new Service($payload);
        $service->uuid = SERVICE_UUID;
        $service->save();
        $service->name = "$name-".$service->uuid;
        $service->save();
        if ($oneClickDotEnvs?->count() > 0) {
            $oneClickDotEnvs->each(function ($value) use ($service) {
                $key = str()->before($value, '=');
                $value = str(str()->after($value, '='));
                if ($value) {
                    $service->environment_variables()->updateOrCreate(['key' => $key], ['value' => $value, 'resourceable_id' => $service->id, 'resourceable_type' => $service->getMorphClass(), 'is_preview' => false]);
                }
            });
        }
        $service->parse(isNew: true);
        applyServiceApplicationPrerequisites($service);
        $before = state($service);

        // The page: "Edit Compose file", the edited text, "Save changes".
        $raw = edited($service->fresh()->docker_compose_raw, $case['replacements']);
        $component = Livewire::test(RecordingStackForm::class, ['service' => $service->fresh()]);
        $fields = $component->get('fields')->map(fn ($field) => ['key' => $field['key'], 'name' => $field['name'], 'serviceName' => $field['serviceName'], 'isPassword' => (bool) $field['isPassword'], 'isLocked' => (bool) $field['isLocked'], 'rules' => $field['rules'], 'value' => $field['value']])->values()->all();
        $hidden = $component->get('isPasswordHiddenForMember');
        $component->call('saveCompose', $raw);
        $events = $component->get('emitted');
        $after = state($service);
        $out['cases'][$case['id']] = ['ok' => true, 'template' => $name, 'raw' => $raw, 'fields' => $fields, 'isPasswordHiddenForMember' => $hidden, 'events' => $events, 'before' => $before, 'after' => $after];
    } catch (Throwable $e) {
        $out['cases'][$case['id']] = ['ok' => false, 'template' => $name, 'error' => get_class($e).': '.$e->getMessage()];
    }
    DB::rollBack();
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
