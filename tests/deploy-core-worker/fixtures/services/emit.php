<?php
// Creates every one-click service of the catalogue the way Coolify does and prints what its Compose
// parser made of it — Coolify's own code (coollabsio/coolify@91b7e3e, Apache-2.0), nothing here is a port.
// Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> <catalogue json> [--variant=<name>] [name …] > goldens.json
//
// Without a variant the server is as Coolify creates one: no wildcard domain, no proxy chosen, both
// proxies' labels. The variants change the server before any service is created:
//   --variant=traefik-exact   proxy Traefik, "generate exact labels" on, wildcard domain https://apps.example.com
//   --variant=caddy-exact     proxy Caddy,   "generate exact labels" on, wildcard domain http://example.org
//
// <catalogue json> is the catalogue to create services from: Coolify's
// templates/service-templates-latest.json format (the scratch copy's, after emit-catalogue.php ran).
//
// Database: Coolify's `testing` connection (SQLite in memory) with all of Coolify's migrations, as its
// own test suite uses. Each template runs in a transaction that is rolled back, so every service gets
// id 1 and its parts ids from 1.
//
// Per template, as app/Livewire/Project/Resource/Create.php::createResource does:
//   new Service(payload)->save(), name, the template's envs, $service->parse(isNew: true),
//   applyServiceApplicationPrerequisites($service)                          -> "first"
//   then $service->fresh()->parse() once more                              -> "second" ("same" if equal)
//
// What is fixed: the fixture below; the service uuid; the uuids of the parts ("sub" + a counter, set by a
// model event after Coolify's own); the clock (2026-01-01T00:00:00Z, for the Supabase JWTs).
// What is random and stays random: the generated values of SERVICE_PASSWORD_*, SERVICE_USER_*,
// SERVICE_BASE64_*, SERVICE_HEX_*, SERVICE_REALBASE64_* (Str::password and random_bytes cannot be
// seeded). They are emitted as generated; the test hands each of them to the port's random source
// and checks its shape, so everything derived from them is still compared byte for byte.
// Jobs and events are faked (Bus, Queue, Event listeners of volumes would open SSH connections).

use App\Models\Environment;
use App\Models\InstanceSettings;
use App\Models\Project;
use App\Models\Server;
use App\Models\Service;
use App\Models\ServiceApplication;
use App\Models\ServiceDatabase;
use App\Models\StandaloneDocker;
use App\Models\Team;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;

$root = $argv[1];
$catalogueFile = $argv[2];
$only = array_slice($argv, 3);
$variant = null;
if (isset($only[0]) && str_starts_with($only[0], '--variant=')) {
    $variant = substr(array_shift($only), strlen('--variant='));
}
const VARIANTS = [
    'traefik-exact' => ['proxy' => 'TRAEFIK', 'wildcard_domain' => 'https://apps.example.com'],
    'caddy-exact' => ['proxy' => 'CADDY', 'wildcard_domain' => 'http://example.org'],
];
if ($variant !== null && ! isset(VARIANTS[$variant])) {
    fwrite(STDERR, "Unknown variant $variant.\n");
    exit(2);
}

// The cache must not be Redis: get_service_templates() caches the catalogue, and Service::getRequiredPort()
// answers null when that throws.
foreach (['DB_CONNECTION' => 'testing', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

Artisan::call('migrate', ['--force' => true]);
Bus::fake();
Queue::fake();
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

// The fixture: one team, one server (no wildcard domain, so domains are <name>-<uuid>.<ip>.sslip.io),
// its default destination (network "coolify"), one project, one environment.
InstanceSettings::forceCreate(['id' => 0]);
$team = Team::forceCreate(['name' => 'Fixture Team', 'personal_team' => false, 'show_boarding' => false]);
$server = Server::forceCreate(['uuid' => 'srv0uuid0000000000000001', 'name' => 'fixture-server', 'ip' => '203.0.113.10', 'team_id' => $team->id, 'private_key_id' => 1]);
if ($variant !== null) {
    $server->proxy->type = VARIANTS[$variant]['proxy'];
    $server->save();
    $server->settings->generate_exact_labels = true;
    $server->settings->wildcard_domain = VARIANTS[$variant]['wildcard_domain'];
    $server->settings->save();
    $server = $server->fresh();
}
$destination = StandaloneDocker::where('server_id', $server->id)->firstOrFail();
$project = Project::forceCreate(['uuid' => 'prj0uuid0000000000000001', 'name' => 'Fixture Project', 'team_id' => $team->id]);
$environment = Environment::where('project_id', $project->id)->firstOrFail(); // "production", created with the project

$fixture = [
    'variant' => $variant,
    'coolify_version' => config('constants.coolify.version'),
    'service_uuid' => SERVICE_UUID,
    'server' => ['ip' => $server->ip, 'wildcard_domain' => $server->settings->wildcard_domain, 'proxy_type' => $server->proxyType(), 'generate_exact_labels' => (bool) $server->settings->generate_exact_labels, 'traefik_certificate_resolver' => $server->traefikCertificateResolver(), 'is_traffic_analytics_enabled' => $server->isTrafficAnalyticsEnabled(), 'caddy_supports_log_append' => $server->caddySupportsLogAppend(), 'is_log_drain_enabled' => (bool) $server->isLogDrainEnabled()],
    'destination' => ['network' => $destination->network],
    'project' => ['name' => $project->name],
    'environment' => ['name' => $environment->name],
    'base_configuration_dir' => base_configuration_dir(),
];

// Left out of every row: timestamps, and last_online_at (its column default is a date frozen into the schema).
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
                // EnvironmentVariable encrypts a serialized value, the `encrypted` cast of LocalFileVolume a plain string.
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
    // The volumes of the service's parts, in the order they were created, without their random uuid.
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
        // Without the uuid of each variable: it is random and nothing refers to it.
        'environment_variables' => array_map(fn ($row) => array_diff_key($row, ['uuid' => 1]), rows('environment_variables', ['resourceable_type' => Service::class, 'resourceable_id' => $service->id], ['value'])),
        'persistent_volumes' => $partsOf('local_persistent_volumes'),
        'file_volumes' => $partsOf('local_file_volumes', ['content']),
    ];
}

$services = collect(json_decode(file_get_contents($catalogueFile)))->sortKeys();
if (get_service_templates()->keys()->all() !== $services->keys()->all()) {
    fwrite(STDERR, "The catalogue given is not the one this Coolify reads (templates/service-templates-latest.json).\n");
    exit(1);
}
$out = ['fixture' => $fixture, 'services' => []];

foreach ($services as $name => $template) {
    if ($only && ! in_array($name, $only, true)) {
        continue;
    }
    $subCounter = 0;
    DB::beginTransaction();
    try {
        // app/Livewire/Project/Resource/Create.php::createResource, from "$services = get_service_templates()".
        $oneClickServiceName = $name;
        $oneClickService = data_get($template, 'compose');
        $oneClickDotEnvs = data_get($template, 'envs', null);
        if ($oneClickDotEnvs) {
            $oneClickDotEnvs = str(base64_decode($oneClickDotEnvs))->split('/\r\n|\r|\n/')->filter(function ($value) {
                return ! empty($value);
            });
        }
        $service_payload = [
            'docker_compose_raw' => base64_decode($oneClickService),
            'environment_id' => $environment->id,
            'service_type' => $oneClickServiceName,
            'server_id' => $destination->server_id,
            'destination_id' => $destination->id,
            'destination_type' => $destination->getMorphClass(),
        ];
        if (in_array($oneClickServiceName, NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK)) {
            data_set($service_payload, 'connect_to_docker_network', true);
        }
        $service = new Service($service_payload);
        $service->uuid = SERVICE_UUID;
        $service->save();
        $service->name = "$oneClickServiceName-".$service->uuid;
        $service->save();
        if ($oneClickDotEnvs?->count() > 0) {
            $oneClickDotEnvs->each(function ($value) use ($service) {
                $key = str()->before($value, '=');
                $value = str(str()->after($value, '='));
                if ($value) {
                    $service->environment_variables()->updateOrCreate(['key' => $key], [
                        'value' => $value,
                        'resourceable_id' => $service->id,
                        'resourceable_type' => $service->getMorphClass(),
                        'is_preview' => false,
                    ]);
                }
            });
        }
        $service->parse(isNew: true);
        applyServiceApplicationPrerequisites($service);

        $first = state($service);
        $service->fresh()->parse();
        $second = state($service);
        $out['services'][$name] = ['ok' => true, 'first' => $first, 'second' => $second === $first ? 'same' : $second];
    } catch (Throwable $e) {
        $out['services'][$name] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
    DB::rollBack();
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
