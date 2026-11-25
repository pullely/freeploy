<?php
// Runs Coolify's own catalogue generator (coollabsio/coolify@91b7e3e, `php artisan generate:services`)
// and prints catalogue-golden.json — nothing here is a port. Usage (see README.md):
//
//   php emit-catalogue.php <coolify root with vendor/ and a .env> > catalogue-golden.json
//
// The generator writes templates/service-templates-latest.json (and service-templates.json) INTO the
// given root, so the root must be a scratch copy. The golden is that file with two changes that keep it
// small and reproducible: `compose` (and `envs`) are replaced by their sha256, and
// `template_last_updated_at` is left out, because the generator takes it from `git log`, which the
// scratch copy does not have.

[$root] = [$argv[1]];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

if (Illuminate\Support\Facades\Artisan::call('generate:services') !== 0) {
    fwrite(STDERR, "generate:services failed\n");
    exit(1);
}

$catalogue = json_decode(file_get_contents($root.'/templates/service-templates-latest.json'), true, 512, JSON_THROW_ON_ERROR);
$golden = [];
foreach ($catalogue as $name => $entry) {
    $entry['compose'] = hash('sha256', $entry['compose']);
    if (isset($entry['envs'])) {
        $entry['envs'] = hash('sha256', $entry['envs']);
    }
    unset($entry['template_last_updated_at']);
    $golden[$name] = $entry;
}

echo json_encode($golden, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
