<?php
// Runs Symfony YAML as Coolify calls it (coollabsio/coolify@91b7e3e, symfony/yaml from its
// composer.lock) and prints goldens.json — nothing here is a port. Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// Output:
//   dump.<id>       Yaml::dump($value, 10, 2) of the case's value
//   parse.<id>      { ok: true, value: <typed>, dump: Yaml::dump(Yaml::parse($yaml), 10, 2) } or
//                   { ok: false, error: <message without the position> }; a case with "compose": true
//                   goes through Coolify's parseDockerComposeYaml instead of Yaml::parse
//   templates.<file> sha256 of Yaml::dump(Yaml::parse($raw), 10, 2) for every templates/compose/*.y(a)ml
//
// A typed value keeps what JSON loses: { "$float": "<repr>" } for a float, { "$map": [[key, value], …] }
// for every array (a PHP array is an ordered map; whether it is a list is decided when it is dumped).

use Symfony\Component\Yaml\Exception\ParseException;
use Symfony\Component\Yaml\Yaml;

[$root, $casesFile] = [$argv[1], $argv[2]];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

function decodeTyped(mixed $value): mixed
{
    if (! is_array($value)) {
        return $value;
    }
    if (array_key_exists('$float', $value)) {
        return match ($value['$float']) {
            'INF' => INF, '-INF' => -INF, 'NAN' => NAN, default => (float) $value['$float'],
        };
    }
    if (array_key_exists('$map', $value)) {
        $map = [];
        foreach ($value['$map'] as [$key, $item]) {
            $map[$key] = decodeTyped($item);
        }

        return $map;
    }

    return array_map('decodeTyped', $value);
}

function encodeTyped(mixed $value): mixed
{
    if (is_float($value)) {
        return ['$float' => (string) $value];
    }
    if (is_array($value)) {
        $pairs = [];
        foreach ($value as $key => $item) {
            $pairs[] = [$key, encodeTyped($item)];
        }

        return ['$map' => $pairs];
    }

    return $value;
}

$cases = json_decode(file_get_contents($casesFile), true, 512, JSON_THROW_ON_ERROR);
$out = ['dump' => [], 'parse' => [], 'templates' => []];

foreach ($cases['dump'] as $case) {
    $out['dump'][$case['id']] = Yaml::dump(decodeTyped($case['value']), 10, 2);
}

foreach ($cases['parse'] as $case) {
    try {
        $value = ($case['compose'] ?? false) ? parseDockerComposeYaml($case['yaml']) : Yaml::parse($case['yaml']);
        $out['parse'][$case['id']] = ['ok' => true, 'value' => encodeTyped($value), 'dump' => Yaml::dump($value, 10, 2)];
    } catch (ParseException $e) {
        $out['parse'][$case['id']] = ['ok' => false, 'error' => $e->getMessage()];
    }
}

$files = array_merge(glob($root.'/templates/compose/*.yaml'), glob($root.'/templates/compose/*.yml'));
sort($files);
foreach ($files as $file) {
    $raw = file_get_contents($file);
    $dump = Yaml::dump(Yaml::parse($raw), 10, 2);
    if ($dump !== Yaml::dump(parseDockerComposeYaml($raw), 10, 2)) {
        fwrite(STDERR, 'parseDockerComposeYaml differs from Yaml::parse for '.basename($file)."\n");
        exit(1);
    }
    $out['templates'][basename($file)] = hash('sha256', $dump);
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
