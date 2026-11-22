#!/usr/bin/env bash
# Seed the reference Coolify with the deterministic fixtures in
# tools/parity/fixtures/base.json, through Coolify's own /api/v1.
#
# The one step the API cannot do is the first one: enabling the API and
# minting a token for the root user. That runs through `php artisan tinker`
# inside the coolify container, exactly as an operator would from Settings →
# API. Everything after it is an API call, so the same fixtures can be
# applied to Freeploy stage through Freeploy's /api/v1 (apply.ts).
#
# Writes $OUT/reference.ids.json: fixture name → the uuid the reference gave it.
set -euo pipefail
OUT="${OUT:-tools/parity/out}"
# shellcheck disable=SC1091
. "$OUT/reference.env"
umask 077

token=$(docker exec coolify php artisan tinker --execute '
$s = \App\Models\InstanceSettings::get();
$s->is_api_enabled = true; $s->allowed_ips = null; $s->save();
// The same as "Skip setup" on /onboarding: otherwise every page redirects there.
\App\Models\Team::find(0)->forceFill(["show_boarding" => false])->save();
$u = \App\Models\User::find(0);
$t = $u->createToken("parity", ["root"], null, 0);
echo $t->plainTextToken;' | tail -n 1 | tr -d '\r')
[ -n "$token" ] || { echo "could not mint a reference API token" >&2; exit 1; }
printf 'REFERENCE_TOKEN=%s\n' "$token" >> "$OUT/reference.env"

node tools/parity/fixtures/apply.ts --base "$REFERENCE_URL" --token-env REFERENCE_TOKEN \
  --env-file "$OUT/reference.env" --fixtures tools/parity/fixtures/base.json \
  --out "$OUT/reference.ids.json"
