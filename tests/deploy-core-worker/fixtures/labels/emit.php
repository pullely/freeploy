<?php
// Runs Coolify's own label code (coollabsio/coolify@91b7e3e, Apache-2.0) over cases.json and
// prints goldens.json — nothing here is a port. Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// The application is booted as Laravel boots it (config, helpers, constants); no database is
// touched: the models are built in memory with their relations set, and save() is a no-op.
//
// Output: { "<case id>": { "ok": true, "value": … } | { "ok": false, "error": "<class>: <message>" } }

use App\Models\Application;
use App\Models\ApplicationPreview;
use App\Models\ApplicationSetting;
use App\Models\Server;
use App\Models\ServerSetting;
use App\Models\StandaloneDocker;
use Illuminate\Support\Collection;

[$root, $casesFile] = [$argv[1], $argv[2]];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

/** An Application that is never written: parseContainerLabels() calls save(). */
class UnsavedApplication extends Application
{
    protected $table = 'applications';

    public function save(array $options = [])
    {
        return true;
    }
}

function buildApplication(array $a): Application
{
    $serverSettings = (new ServerSetting)->setRawAttributes($a['server']['settings']);
    $server = (new Server)->setRawAttributes(['name' => 'server', 'proxy' => json_encode($a['server']['proxy'])]);
    $server->setRelation('settings', $serverSettings);

    $destination = (new StandaloneDocker)->setRawAttributes(['network' => $a['destination']['network']]);
    $destination->setRelation('server', $server);

    $application = new UnsavedApplication;
    foreach ($a as $key => $value) {
        if (! in_array($key, ['settings', 'destination', 'server'], true)) {
            // Through the model's casts: `encrypted` for the password, `array` for the JSON columns.
            $application->{$key} = $value;
        }
    }
    $application->setRelation('settings', (new ApplicationSetting)->setRawAttributes($a['settings']));
    $application->setRelation('destination', $destination);

    return $application;
}

function buildPreview(?array $p): ?ApplicationPreview
{
    if ($p === null) {
        return null;
    }
    $preview = new ApplicationPreview;
    foreach ($p as $key => $value) {
        $preview->{$key} = $value;
    }

    return $preview;
}

/**
 * General::rules(), messages() and $validationAttributes for the Labels and Authentication fields,
 * through Laravel's validator as Livewire's validate() runs it. A field the case leaves out keeps the
 * component's default.
 */
function validateGeneralLabelFields(array $data): array
{
    $fields = ['customLabels', 'isContainerLabelEscapeEnabled', 'isContainerLabelReadonlyEnabled', 'isHttpBasicAuthEnabled', 'httpBasicAuthUsername',
        'httpBasicAuthPassword', 'httpBasicAuthHashAlgorithm', 'httpBasicAuthBcryptCost', 'httpBasicAuthArgon2idMemoryCost', 'httpBasicAuthArgon2idTimeCost'];
    $component = new App\Livewire\Project\Application\General;
    $read = fn (string $what) => (fn () => $what === 'attributes' ? $this->validationAttributes : $this->{$what}())->call($component);
    $defaults = [];
    foreach ($fields as $field) {
        $defaults[$field] = $component->{$field};
    }
    $rules = array_intersect_key($read('rules'), array_flip($fields));
    if (count($rules) !== count($fields)) {
        throw new RuntimeException('General::rules() does not have every label field');
    }

    return Illuminate\Support\Facades\Validator::make(array_merge($defaults, $data), $rules, $read('messages'), $read('attributes'))->errors()->toArray();
}

function listOf(mixed $value): mixed
{
    return $value instanceof Collection ? array_values($value->all()) : $value;
}

$file = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR);
$defaults = $file['applicationDefaults'];
$out = [];
foreach ($file['cases'] as $case) {
    $args = $case['args'];
    try {
        switch ($case['fn']) {
            case 'fqdnLabelsForTraefik':
            case 'fqdnLabelsForCaddy':
                foreach (['domains', 'serviceLabels', 'noindex_domains'] as $key) {
                    if (isset($args[$key])) {
                        $args[$key] = collect($args[$key]);
                    }
                }
                // The collection is sorted with its keys kept; its order is what a caller iterates.
                $value = listOf($case['fn'](...$args));
                break;
            case 'generateLabelsApplication':
                $application = buildApplication(array_replace_recursive($defaults, $args['application']));
                $value = generateLabelsApplication($application, buildPreview($args['preview'] ?? null));
                break;
            case 'parseContainerLabels':
                $application = buildApplication(array_replace_recursive($defaults, $args['application']));
                $returned = $application->parseContainerLabels();
                $value = ['returned' => $returned === null ? null : (string) $returned, 'stored' => $application->getAttributes()['custom_labels'] ?? null];
                break;
            case 'validateGeneralLabelFields':
                $value = validateGeneralLabelFields($args);
                break;
            case 'defaultLabels':
                $value = listOf(defaultLabels(...$args));
                break;
            case 'traefikHostRulesWithoutIpv6Brackets':
                $value = listOf(traefikHostRulesWithoutIpv6Brackets(collect($args[0])));
                break;
            case 'isNoindexDomain':
                $value = isNoindexDomain($args[0], $args[1] === null ? null : collect($args[1]));
                break;
            case 'caddyDockerProxyImageVersion':
                $value = Server::caddyDockerProxyImageVersion(...$args);
                break;
            case 'decodeBase64EncodedLabels':
            case 'isBase64Encoded':
            case 'escapeDollarSign':
            case 'caddySiteAddress':
                $value = $case['fn'](...$args);
                break;
            default:
                throw new RuntimeException("no such case function {$case['fn']}");
        }
        $out[$case['id']] = ['ok' => true, 'value' => $value];
    } catch (Throwable $e) {
        $out[$case['id']] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}
if (count($out) !== count($file['cases'])) {
    throw new RuntimeException('duplicate case ids');
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)."\n";
fwrite(STDERR, 'emitted '.count($out).' goldens with PHP '.PHP_VERSION.', Coolify '.config('constants.coolify.version')."\n");
