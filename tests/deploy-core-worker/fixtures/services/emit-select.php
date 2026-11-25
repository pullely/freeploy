<?php
// Runs the New Resource page's own service list (coollabsio/coolify@91b7e3e,
// App\Livewire\Project\New\Select::loadServices) and prints select-golden.json — nothing here is a port.
// Usage (see README.md), after emit-catalogue.php wrote the catalogue into the same root:
//
//   php emit-select.php <coolify root with vendor/ and a .env> > select-golden.json
//
// Left out of each service: `compose` and `envs` (the catalogue golden has their hashes),
// `template_last_updated_at` and `templateLastUpdated` (git and file times of the scratch copy).
// The logo URLs are Laravel's asset() URLs, here below http://localhost.

foreach (['DB_CONNECTION' => 'testing', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array', 'APP_URL' => 'http://localhost'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
$root = $argv[1];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$loaded = (new App\Livewire\Project\New\Select)->loadServices();
$services = [];
foreach ($loaded['services'] as $key => $service) {
    unset($service['compose'], $service['envs'], $service['template_last_updated_at'], $service['templateLastUpdated']);
    $service['name'] = (string) $service['name'];
    $services[$key] = $service;
}

echo json_encode(['services' => $services, 'categories' => $loaded['categories']], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
