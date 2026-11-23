#!/usr/bin/env bash
# Run tools/parity/commands/cases.json through the reference Coolify's own
# helpers and write the outputs to $OUT/goldens.reference.json.
set -euo pipefail
OUT="${OUT:-tools/parity/out}"
here="$(cd "$(dirname "$0")" && pwd)"
docker cp "$here/cases.json" coolify:/tmp/parity-cases.json
docker cp "$here/emit.php" coolify:/tmp/parity-emit.php
docker exec coolify php artisan tinker --execute 'require "/tmp/parity-emit.php";'
docker cp coolify:/tmp/parity-goldens.json "$OUT/goldens.reference.json"
