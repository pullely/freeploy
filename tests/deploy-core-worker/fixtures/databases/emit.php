<?php
// Runs Coolify's own database code (coollabsio/coolify@91b7e3e, Apache-2.0) and prints goldens.json —
// nothing here is a port. Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// The application is booted as Laravel boots it. `created` runs the real create_standalone_*()
// helpers against an in-memory SQLite database that holds only the tables they write (every column
// nullable, so what comes back non-null is what Coolify's code set, not a schema default); `urls`
// builds the models in memory and reads their internal_db_url / external_db_url accessors;
// `validation` runs Laravel's validator with each General component's own rules(), messages() and
// $validationAttributes; `password` is Str::password(length: 64, symbols: false) a few times, as
// shapes.

use App\Models\EnvironmentVariable;
use App\Models\LocalPersistentVolume;
use App\Models\Server;
use App\Models\StandaloneDocker;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

[$root, $casesFile] = [$argv[1], $argv[2]];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$cases = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR);

const ENGINES = [
    'postgresql' => ['model' => App\Models\StandalonePostgresql::class, 'general' => App\Livewire\Project\Database\Postgresql\General::class, 'create' => 'create_standalone_postgresql'],
    'redis' => ['model' => App\Models\StandaloneRedis::class, 'general' => App\Livewire\Project\Database\Redis\General::class, 'create' => 'create_standalone_redis'],
    'mysql' => ['model' => App\Models\StandaloneMysql::class, 'general' => App\Livewire\Project\Database\Mysql\General::class, 'create' => 'create_standalone_mysql'],
    'mariadb' => ['model' => App\Models\StandaloneMariadb::class, 'general' => App\Livewire\Project\Database\Mariadb\General::class, 'create' => 'create_standalone_mariadb'],
    'mongodb' => ['model' => App\Models\StandaloneMongodb::class, 'general' => App\Livewire\Project\Database\Mongodb\General::class, 'create' => 'create_standalone_mongodb'],
    'keydb' => ['model' => App\Models\StandaloneKeydb::class, 'general' => App\Livewire\Project\Database\Keydb\General::class, 'create' => 'create_standalone_keydb'],
    'dragonfly' => ['model' => App\Models\StandaloneDragonfly::class, 'general' => App\Livewire\Project\Database\Dragonfly\General::class, 'create' => 'create_standalone_dragonfly'],
    'clickhouse' => ['model' => App\Models\StandaloneClickhouse::class, 'general' => App\Livewire\Project\Database\Clickhouse\General::class, 'create' => 'create_standalone_clickhouse'],
    // DP-112
    'sqlite' => ['model' => App\Models\StandaloneSqlite::class, 'general' => App\Livewire\Project\Database\Sqlite\General::class, 'create' => 'create_standalone_sqlite'],
];

/** A generated secret is random: its shape is the golden, not its value. */
function shape(?string $value): array
{
    return [
        'length' => strlen((string) $value),
        'alphanumeric' => preg_match('/^[A-Za-z0-9]+$/', (string) $value) === 1,
        'hasLetter' => preg_match('/[A-Za-z]/', (string) $value) === 1,
        'hasDigit' => preg_match('/[0-9]/', (string) $value) === 1,
    ];
}

$out = ['types' => [], 'created' => [], 'urls' => [], 'validation' => [], 'password' => []];

// ---------------------------------------------------------------- types, and the tables `created` writes
foreach (ENGINES as $type => $engine) {
    $model = new $engine['model'];
    Schema::create($model->getTable(), function (Blueprint $table) use ($model) {
        $table->id();
        foreach (array_unique([...$model->getFillable(), 'config_hash']) as $column) {
            $table->text($column)->nullable();
        }
        $table->timestamps();
        $table->softDeletes();
    });
    $casts = $model->getCasts();
    $encrypted = array_keys(array_filter($casts, fn ($cast) => $cast === 'encrypted'));
    sort($encrypted);
    $out['types'][$type] = [
        'morphClass' => $model->getMorphClass(),
        'type' => $model->type(),
        'table' => $model->getTable(),
        // Create::pendingResource(): "Creating {{ $pendingName }}".
        'headline' => str($type)->headline()->value(),
        'backups' => $model->isBackupSolutionAvailable(),
        'encrypted' => $encrypted,
    ];
}
Schema::create('local_persistent_volumes', function (Blueprint $table) {
    $table->id();
    foreach (['uuid', 'name', 'mount_path', 'host_path', 'container_id', 'resource_type', 'resource_id', 'is_preview_suffix_enabled', 'standalone_sqlite_id', 'ignores_compose_driver_options'] as $column) {
        $table->text($column)->nullable();
    }
    $table->timestamps();
});
Schema::create('environment_variables', function (Blueprint $table) {
    $table->id();
    foreach (array_unique([...(new EnvironmentVariable)->getFillable(), 'uuid', 'is_shared']) as $column) {
        $table->text($column)->nullable();
    }
    $table->timestamps();
});

// ---------------------------------------------------------------- created
$destination = (new StandaloneDocker)->forceFill(['id' => 21, 'network' => 'coolify']);
$destination->exists = true;

foreach ($cases['created'] as $id => $case) {
    try {
        $type = $case['type'];
        $image = $case['database_image'] ?? null;
        // Create::createResource()
        $database = match ($type) {
            'postgresql' => create_standalone_postgresql(environmentId: 11, destination: $destination, databaseImage: $image),
            'redis' => create_standalone_redis(11, $destination, ['image' => $image]),
            default => (ENGINES[$type]['create'])(11, $destination),
        };
        $row = (array) DB::table($database->getTable())->where('id', $database->id)->first();
        $encrypted = array_keys(array_filter($database->getCasts(), fn ($cast) => $cast === 'encrypted'));
        $attributes = [];
        foreach ($row as $column => $value) {
            if ($value === null || in_array($column, ['id', 'created_at', 'updated_at'], true)) {
                continue;
            }
            if ($column === 'uuid') {
                $attributes[$column] = ['length' => strlen($value), 'lowerAlphanumeric' => preg_match('/^[a-z0-9]+$/', $value) === 1];
            } elseif ($column === 'name') {
                $attributes[$column] = str_replace($database->uuid, '{uuid}', $value);
            } elseif (in_array($column, $encrypted, true)) {
                $attributes[$column] = ['encrypted' => $value !== $database->{$column}] + shape($database->{$column});
            } else {
                $attributes[$column] = $value;
            }
        }
        ksort($attributes);
        $volumes = LocalPersistentVolume::where('resource_id', $database->id)->where('resource_type', $database->getMorphClass())->orderBy('id')->get()
            ->map(fn ($v) => ['name' => str_replace($database->uuid, '{uuid}', $v->name), 'mount_path' => $v->mount_path, 'host_path' => $v->host_path, 'resource_type' => $v->resource_type])->all();
        $variables = DB::table('environment_variables')->where('resourceable_id', $database->id)->where('resourceable_type', $database->getMorphClass())->orderBy('id')->get()
            ->map(function ($v) {
                $model = EnvironmentVariable::find($v->id);
                $set = array_filter((array) $v, fn ($value, $column) => $value !== null && ! in_array($column, ['id', 'created_at', 'updated_at', 'resourceable_id', 'uuid', 'value', 'version'], true), ARRAY_FILTER_USE_BOTH);
                ksort($set);

                return $set + [
                    'value' => $v->key === 'REDIS_PASSWORD' ? shape($model->value) : $model->value,
                    'valueEncrypted' => $v->value !== $model->value,
                    'hasUuid' => $v->uuid !== null,
                    'versionIsCoolifys' => $v->version === config('constants.coolify.version'),
                ];
            })->all();
        $out['created'][$id] = ['ok' => true, 'attributes' => $attributes, 'volumes' => $volumes, 'environmentVariables' => $variables];
    } catch (Throwable $e) {
        $out['created'][$id] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}

// ---------------------------------------------------------------- urls
function buildDatabase(string $type, array $case): object
{
    $server = (new Server)->forceFill(['id' => 7, 'ip' => $case['serverIp'] ?? '203.0.113.10']);
    $destination = (new StandaloneDocker)->forceFill(['id' => 21]);
    $destination->setRelation('server', $server);
    $class = ENGINES[$type]['model'];
    $database = new $class;
    $database->forceFill(['id' => 5, 'uuid' => 'dbuuid']);
    foreach ($case['attributes'] as $key => $value) {
        $database->{$key} = $value;
    }
    // BaseModel's `image` accessor reads the stored value (getRawOriginal), as after a load from the database.
    $database->syncOriginal();
    $database->setRelation('destination', $destination);
    $variables = collect($case['environmentVariables'] ?? [])->map(function ($v) {
        $variable = new EnvironmentVariable;
        $variable->forceFill(['key' => $v['key'], 'is_shown_once' => $v['is_shown_once'] ?? false, 'is_shared' => $v['is_shared'] ?? false]);
        $variable->value = $v['value'];

        return $variable;
    });
    $database->setRelation('runtime_environment_variables', $variables);
    $database->setRelation('environment_variables', $variables);

    return $database;
}

foreach ($cases['urls'] as $id => $case) {
    try {
        $database = buildDatabase($case['type'], $case);
        $out['urls'][$id] = ['ok' => true, 'internal' => $database->internal_db_url, 'external' => $database->external_db_url];
    } catch (Throwable $e) {
        $out['urls'][$id] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}

// ---------------------------------------------------------------- validation
foreach ($cases['validation'] as $id => $case) {
    try {
        // A case gives what differs from its type's base: fields of `input`; `stored` and `environmentVariables` whole.
        $base = $cases['validationBase'][$case['type']];
        $case = ['type' => $case['type'], 'stored' => $case['stored'] ?? $base['stored'], 'environmentVariables' => $case['environmentVariables'] ?? $base['environmentVariables'],
            'input' => array_replace($base['input'], $case['input'])];
        $database = buildDatabase($case['type'], ['attributes' => $case['stored'], 'environmentVariables' => $case['environmentVariables']]);
        $class = ENGINES[$case['type']]['general'];
        $component = new $class;
        $component->database = $database;
        // What validate() sees is the component's properties: PHP has coerced each value to the
        // property's type (12345 is "12345" in a string property, "maybe" is true in a ?bool one).
        // A value the property cannot hold never reaches the validator: Livewire fails on it.
        $data = [];
        $typeErrors = [];
        foreach ($case['input'] as $property => $value) {
            try {
                $component->{$property} = $value;
                $data[$property] = $component->{$property};
            } catch (TypeError) {
                $typeErrors[] = $property;
            }
        }
        if ($typeErrors !== []) {
            $out['validation'][$id] = ['ok' => true, 'typeErrors' => $typeErrors];

            continue;
        }
        $read = function () {
            return [$this->rules(), $this->messages(), property_exists($this, 'validationAttributes') ? $this->validationAttributes : []];
        };
        [$rules, $messages, $attributes] = Closure::bind($read, $component, $class)();
        $validator = Validator::make($data, $rules, $messages, $attributes);
        $out['validation'][$id] = ['ok' => true, 'errors' => (object) $validator->errors()->toArray()];
    } catch (Throwable $e) {
        $out['validation'][$id] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}

// ---------------------------------------------------------------- password
for ($i = 0; $i < 5; $i++) {
    $out['password'][] = shape(Str::password(length: 64, symbols: false));
}

// One case per line, so that a regeneration shows as the lines that changed.
$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
$sections = [];
foreach ($out as $name => $section) {
    $lines = [];
    foreach ($section as $id => $value) {
        $lines[] = '  '.json_encode((string) $id, $flags).': '.json_encode($value, $flags);
    }
    $sections[] = ' '.json_encode($name, $flags).": {\n".implode(",\n", $lines)."\n }";
}
echo "{\n".implode(",\n", $sections)."\n}\n";
