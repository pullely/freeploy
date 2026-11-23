<?php
// Derived from coollabsio/coolify@91b7e3e (Apache-2.0): runs Coolify's own
// bootstrap/helpers functions — not a port. Executed inside the reference
// container through `php artisan tinker` (emit.sh), so the helpers run with
// the application booted exactly as in production.
//
// Reads /tmp/parity-cases.json, writes /tmp/parity-goldens.json:
//   { "<case id>": { "ok": true, "type": "string", "value": … } | { "ok": false, "error": "<class>: <message>" } }
// Collections are written as arrays; every other value as json_encode gives it.
$cases = json_decode(file_get_contents('/tmp/parity-cases.json'), true)['cases'];
$out = [];
foreach ($cases as $case) {
    try {
        if (! function_exists($case['fn'])) {
            throw new RuntimeException("no such helper {$case['fn']}");
        }
        $value = call_user_func_array($case['fn'], $case['args']);
        if ($value instanceof \Illuminate\Support\Collection) {
            $value = $value->toArray();
        }
        $out[$case['id']] = ['ok' => true, 'type' => get_debug_type($value), 'value' => $value];
    } catch (\Throwable $e) {
        $out[$case['id']] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage()];
    }
}
ksort($out);
file_put_contents('/tmp/parity-goldens.json', json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n");
echo 'emitted '.count($out)." goldens\n";
