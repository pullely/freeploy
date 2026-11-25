<?php

// Emits what coollabsio/coolify does for an S3 storage (see README.md): the ListObjectsV2 request of
// its connection test and the error it raises, S3Storage::testConnection() itself, and the rules and
// messages of the New Storage and storage General forms. Nothing in here is a port: every value is
// computed by Coolify's code and its vendored libraries (Laravel, Flysystem, the AWS SDK for PHP).
//
// php emit.php <coolify checkout> <cases.json>   (with fake-s3.php served on 127.0.0.1:9765)

$root = $argv[1];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Enums\BackupStorageType;
use App\Livewire\Storage\Create;
use App\Livewire\Storage\Form;
use App\Models\S3Storage;
use App\Rules\SafeWebhookUrl;
use App\Support\ValidationPatterns;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

$cases = json_decode(file_get_contents($argv[2]), true);
$log = __DIR__.'/requests.jsonl';

/** The requests fake-s3.php saw since the last call; only what the signature covers and the URL. */
$takeRequests = function () use ($log): array {
    if (! is_file($log)) {
        return [];
    }
    $lines = array_filter(explode("\n", file_get_contents($log)));
    unlink($log);

    return array_values(array_map(function (string $line): array {
        $r = json_decode($line, true);
        $h = array_change_key_case($r['headers'], CASE_LOWER);

        return [
            'method' => $r['method'],
            'host' => $r['host'],
            'uri' => $r['uri'],
            'headers' => array_intersect_key($h, array_flip(['host', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-user-agent', 'authorization'])),
        ];
    }, $lines));
};

// Host names as SafeWebhookUrl resolves them here (no DNS is asked).
SafeWebhookUrl::resolveHostsUsing(fn (string $host): array => match ($host) {
    'unresolvable.example' => [],
    'private.example' => ['10.0.0.5'],
    'linklocal.example' => ['169.254.169.254'],
    'mixed.example' => ['93.184.216.34', '10.0.0.9'],
    'localhost' => ['127.0.0.1'],
    default => ['93.184.216.34'],
});

// The instance settings SafeWebhookUrl reads (only these columns); a row exists only while a test lets
// the endpoint be the fake server on localhost.
Schema::create('instance_settings', function ($table) {
    $table->integer('id');
    $table->text('webhook_allowed_internal_hosts')->nullable();
    $table->boolean('webhook_allow_localhost')->default(false);
    $table->text('custom_dns_servers')->nullable();
});

$out = ['requests' => [], 'testConnection' => [], 'validation' => []];

// 1. The disk of S3Storage::s3Filesystem() with files(), as listFilesWithAddressingStyleFallback()
//    calls it; without the DNS pin of httpClientOptions(), whose address would not be the fake server.
foreach ($cases['requests'] as $case) {
    $takeRequests();
    $disk = Storage::build([
        'driver' => 's3',
        'region' => $case['region'],
        'key' => $case['key'],
        'secret' => $case['secret'],
        'bucket' => $case['bucket'],
        'endpoint' => $case['endpoint'],
        'use_path_style_endpoint' => $case['pathStyle'],
        'http' => ['allow_redirects' => false, 'verify' => true, 'connect_timeout' => 15, 'timeout' => 15],
    ]);
    $error = null;
    try {
        $disk->files();
    } catch (\Throwable $e) {
        $error = $e->getMessage();
    }
    $out['requests'][] = ['name' => $case['name'], 'requests' => $takeRequests(), 'error' => $error];
}

// 2. S3Storage::testConnection() on a storage built as Form::testConnection() builds it.
DB::table('instance_settings')->insert(['id' => 0, 'webhook_allowed_internal_hosts' => json_encode(['localhost']), 'webhook_allow_localhost' => true]);
foreach ($cases['testConnection'] as $case) {
    $takeRequests();
    $storage = new S3Storage;
    $storage->type = BackupStorageType::S3;
    $storage->uuid = 'storage-uuid';
    $storage->team_id = 0;
    $storage->unusable_email_sent = false;
    $storage->name = 'Backups';
    foreach ($case['storage'] as $k => $v) {
        $storage->{$k} = $v;
    }
    $error = null;
    try {
        $storage->testConnection();
    } catch (\Throwable $e) {
        $error = $e->getMessage();
    }
    $out['testConnection'][] = [
        'name' => $case['name'],
        'attributes' => array_intersect_key($storage->getAttributes(), array_flip(['region', 'bucket', 'endpoint'])) + ['key' => $storage->key, 'secret' => $storage->secret],
        'requests' => array_map(fn ($r) => ['host' => $r['host'], 'uri' => $r['uri']], $takeRequests()),
        'error' => $error,
        'isUsable' => $storage->is_usable,
        'usesPathStyleEndpoint' => $storage->usesPathStyleEndpoint(),
    ];
}
DB::table('instance_settings')->delete();

// 3. The forms' validation, with each component's own messages() and validationAttributes().
$call = function (object $component, string $method) {
    $m = new ReflectionMethod($component, $method);

    return $m->invoke($component);
};
foreach ($cases['validation'] as $case) {
    $input = array_merge($cases['validationBase'][$case['form']], $case['input']);
    if ($case['form'] === 'create') {
        $component = new Create;
        $component->type = is_string($input['type'] ?? null) ? $input['type'] : 's3';
        $data = $input;
        // Create::submit(): normalizeEndpoint() before validate().
        $data['endpoint'] = (new ReflectionMethod($component, 'normalizeEndpoint'))->invoke($component, (string) $input['endpoint']);
        // Create::rules(), with connectionRules() for the S3 type (the team only matters for SFTP keys).
        $rules = [
            'type' => ['required', Rule::enum(BackupStorageType::class)],
            'name' => ValidationPatterns::nameRules(),
            'description' => ValidationPatterns::descriptionRules(),
            ...S3Storage::connectionRules($component->storageType()),
            'usePathStyleEndpoint' => 'boolean',
            'skipTlsVerification' => 'boolean',
        ];
    } else {
        $component = new Form;
        $storage = new S3Storage;
        $storage->setRawAttributes(['type' => 's3', 'uuid' => 'storage-uuid', 'team_id' => 0, 'endpoint' => $input['savedEndpoint']], true);
        $component->storage = $storage;
        $component->hasSavedSecret = $input['hasSavedSecret'];
        $data = array_diff_key($input, array_flip(['hasSavedSecret', 'savedEndpoint']));
        $rules = $call($component, 'rules');
    }
    $validator = Validator::make($data, $rules, $call($component, 'messages'), $call($component, 'validationAttributes'));
    $out['validation'][] = [
        'form' => $case['form'],
        'input' => $case['input'],
        'endpoint' => $data['endpoint'],
        'errors' => $validator->fails() ? $validator->errors()->toArray() : [],
    ];
}

// 4. BackupEdit's #[Validate] rules, read from the component's properties; no messages or attributes
//    of its own, so Laravel's defaults. And the two checks syncData() and customValidate() make first.
$backupRules = [];
foreach ((new ReflectionClass(App\Livewire\Project\Database\BackupEdit::class))->getProperties() as $property) {
    foreach ($property->getAttributes(Livewire\Attributes\Validate::class) as $attribute) {
        $backupRules[$property->getName()] = $attribute->getArguments()[0];
    }
}
$out['backupRules'] = [$backupRules];
$out['backupValidation'] = [];
foreach ($cases['backupValidation'] as $input) {
    $data = array_merge($cases['backupValidationBase'], $input);
    $errors = [];
    $exception = null;
    try {
        $validator = Validator::make($data, $backupRules);
        $errors = $validator->fails() ? $validator->errors()->toArray() : [];
    } catch (\Throwable $e) {
        $exception = get_class($e).': '.$e->getMessage();
    }
    $out['backupValidation'][] = ['input' => $input, 'errors' => $errors, 'exception' => $exception];
}
$out['databasesToBackup'] = [];
foreach ($cases['databasesToBackup'] as $value) {
    try {
        validateDatabasesBackupInput($value);
        $out['databasesToBackup'][] = ['value' => $value, 'error' => null];
    } catch (\Throwable $e) {
        $out['databasesToBackup'][] = ['value' => $value, 'error' => $e->getMessage()];
    }
}
$out['cron'] = array_map(fn (string $value) => ['value' => $value, 'valid' => validate_cron_expression($value)], $cases['cron']);

$lines = [];
foreach ($out as $section => $items) {
    $lines[] = '  '.json_encode($section).': ['."\n".implode(",\n", array_map(fn ($i) => '    '.json_encode($i, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $items))."\n  ]";
}
echo "{\n".implode(",\n", $lines)."\n}\n";
