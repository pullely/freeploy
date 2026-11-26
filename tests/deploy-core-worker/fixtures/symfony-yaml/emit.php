<?php
// Runs symfony/yaml's Yaml::parse() — the version of coollabsio/coolify@91b7e3e's composer.lock — and Coolify's
// ValidCloudInitYaml (app/Rules/ValidCloudInitYaml.php) over cases.json and prints goldens.json. Nothing here is a port.
//
//   php emit.php <coolify root with vendor/> cases.json > goldens.json
//
// Output, per case id (the hand-written `cases` and the generated `fuzz`):
//   parse      { ok: true, value: <typed> } or { ok: false, error: ParseException::getMessage(), line, snippet }
//   rule       the message ValidCloudInitYaml fails with (":attribute" left in), or null when it passes
// A typed value keeps what JSON loses: { "$float": "<repr>" } for a float, { "$map": [[key, value], …] } for every array,
// { "$tagged": [tag, value] } for a TaggedValue.

use App\Rules\ValidCloudInitYaml;
use Symfony\Component\Yaml\Exception\ParseException;
use Symfony\Component\Yaml\Tag\TaggedValue;
use Symfony\Component\Yaml\Yaml;

[$root, $casesFile] = [$argv[1], $argv[2]];
require $root.'/vendor/autoload.php';

function encodeTyped(mixed $value): mixed
{
    if (is_float($value)) {
        return ['$float' => is_nan($value) ? 'NAN' : (is_infinite($value) ? ($value > 0 ? 'INF' : '-INF') : var_export($value, true))];
    }
    if ($value instanceof TaggedValue) {
        return ['$tagged' => [$value->getTag(), encodeTyped($value->getValue())]];
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
$out = [];
foreach (array_merge($cases['cases'], $cases['fuzz']) as $case) {
    try {
        $parse = ['ok' => true, 'value' => encodeTyped(Yaml::parse($case['yaml']))];
    } catch (ParseException $e) {
        $parse = ['ok' => false, 'error' => $e->getMessage(), 'line' => $e->getParsedLine(), 'snippet' => $e->getSnippet()];
    }
    $rule = null;
    (new ValidCloudInitYaml)->validate('script', $case['yaml'], function (string $message) use (&$rule) {
        $rule = $message;
    });
    $out[$case['id']] = ['parse' => $parse, 'rule' => $rule];
}

echo json_encode(['symfony/yaml' => \Composer\InstalledVersions::getPrettyVersion('symfony/yaml'), 'cases' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
