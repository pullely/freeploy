<?php
// Calls Coolify's own security status copy — coollabsio/coolify@91b7e3e (Apache-2.0); nothing in here is a port — over the
// stored statuses of the API goldens (../api/goldens.json, DP-113's `after` rows) and the scans of their cases
// (../api/cases.json), and prints what SecuritySentences, TeamVulnerabilities and VulnerabilityMarkers say about each, so
// that the port of those pure functions can be compared with them (see README.md).
//
//   php emit.php <coolify root with vendor/> ../api/cases.json ../api/goldens.json > sentences.json
//
// No database: each status is ResourceSecurity::fromArray() of a stored one, each scan an unsaved ImageScan with the case's
// columns (no resource, so no image counts as one Coolify builds). The clock is the goldens' (2026-01-01T00:00:00Z).

use App\Models\ImageScan;
use App\Services\ImageScan\ResourceSecurity;
use App\Services\ImageScan\SecuritySentences;
use App\Services\ImageScan\TeamVulnerabilities;
use App\Services\ImageScan\VulnerabilityMarkers;
use Illuminate\Support\Carbon;

$root = $argv[1];
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
\Carbon\CarbonImmutable::setTestNow(\Carbon\CarbonImmutable::parse('2026-01-01T00:00:00Z'));

$cases = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$goldens = json_decode(file_get_contents($argv[3]), true, 512, JSON_THROW_ON_ERROR);
$scans = [];
foreach ($cases['cases'] as $case) {
    foreach ($case['imageScans'] ?? [] as $scan) {
        $scans[$scan['uuid']] = $scan;
    }
}

$out = [];
$seen = [];
foreach ($goldens['cases'] as $golden) {
    foreach ($golden['after']['scans'] ?? [] as $row) {
        $summary = json_decode($row['summary'] ?? 'null', true);
        $data = $summary['security'] ?? null;
        $definition = $scans[$row['uuid']] ?? null;
        if (! is_array($data) || $definition === null) {
            continue;
        }
        $key = $row['uuid'].':'.md5($row['summary']);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $security = ResourceSecurity::fromArray($data);
        $scan = (new ImageScan)->forceFill([
            'image_ref' => $definition['image_ref'],
            'findings' => $definition['findings'],
            'candidates' => $definition['candidates'],
            'base_image_ref' => $definition['base_image_ref'],
            'builds_image' => $definition['builds_image'],
            'summary' => $summary,
        ]);
        $primary = $security->primary();
        $out[] = [
            'uuid' => $row['uuid'],
            'security' => $data,
            'headline' => SecuritySentences::headline($security),
            'lines' => SecuritySentences::lines($security),
            'badge' => SecuritySentences::badge($security->status),
            'image_sentence' => SecuritySentences::imageSentence($security, (string) $definition['image_ref'], $scan),
            'version_check_running' => SecuritySentences::versionCheckRunning((string) $definition['image_ref'], $scan),
            'attack_note' => SecuritySentences::attackNote($security),
            'no_fix_advice' => SecuritySentences::noFixAdvice($security, 'this database'),
            'why_more' => SecuritySentences::whyMore($security->moreFixed),
            'provenance' => SecuritySentences::provenance($scan, $primary, $security, ['fixed_in' => '1.2.3']),
            'provenance_none' => SecuritySentences::provenance($scan, null, $security),
            'registry' => SecuritySentences::registryName((string) $definition['image_ref']),
            'status_label' => TeamVulnerabilities::statusLabel($security->status),
            'action' => TeamVulnerabilities::action($security),
            'images_line' => TeamVulnerabilities::imagesLine($security, ['update' => 1, 'total' => 2]),
            'marker' => VulnerabilityMarkers::marker($security),
        ];
    }
}
$extra = [
    'images_needing_update' => [SecuritySentences::imagesNeedingUpdate(0, 3), SecuritySentences::imagesNeedingUpdate(1, 3), SecuritySentences::imagesNeedingUpdate(2, 3)],
    'known_issues' => [SecuritySentences::knownIssues(0), SecuritySentences::knownIssues(1), SecuritySentences::knownIssues(12)],
    'short_digest' => [SecuritySentences::shortDigest(null), SecuritySentences::shortDigest('nginx@sha256:3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081'), SecuritySentences::shortDigest('abcdef')],
    'database_update_confirmation' => [SecuritySentences::databaseUpdateConfirmation('PostgreSQL', '16.4-alpine', '16.6-alpine'), SecuritySentences::databaseUpdateConfirmation('Redis', 'latest', 'alpine')],
    'check_reasons' => array_map(fn (string $code): string => SecuritySentences::checkReason($code, ['checked' => 1, 'total' => 3, 'time' => '2025-12-20T08:00:00+00:00']), ['images_unchecked', 'truncated', 'stale', 'db_outdated', 'image_changed', 'versions_unchecked', 'server', 'application', 'not_scanned', 'other']),
];

echo json_encode(['coolify' => '91b7e3e', 'statuses' => $out, 'extra' => $extra], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
