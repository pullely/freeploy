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
$s->is_api_enabled = true; $s->allowed_ips = null;
// The "Love Coolify? Support our work" popup is an instance setting.
// Freeploy never shows it (no affiliation with coollabs.io; the operator
// setting defaults off), so the reference turns it off to compare like with like.
$s->is_sponsorship_popup_enabled = false;
// Freeploy is a SaaS with open sign-up, so the reference allows registration
// too (the predefined root user turns it off): /login then shows the same
// Register link and /register renders instead of redirecting.
$s->is_registration_enabled = true;
// Freeploy always has transactional email (Lumen notifications), so the reference
// gets an SMTP provider too (a fake host, never contacted by the capture): /login
// then offers "Forgot password?" and /forgot-password shows its form.
$s->smtp_enabled = true; $s->smtp_host = "smtp.example.com"; $s->smtp_port = 587;
$s->smtp_from_address = "no-reply@example.com"; $s->smtp_from_name = "Parity"; $s->save();
// The same as "Skip setup" on /onboarding: otherwise every page redirects there.
// Freeploy has no instance root team: a user gets the personal team Coolify
// gives every registered user (the name plus "s Team" with an apostrophe,
// app/Models/User.php), so the reference root team is named the same for the
// root user "Parity Root". chr(39) is the apostrophe: this whole block is
// single-quoted for the shell, so it must never contain one.
\App\Models\Team::find(0)->forceFill(["show_boarding" => false, "name" => "Parity Root" . chr(39) . "s Team"])->save();
$u = \App\Models\User::find(0);
$t = $u->createToken("parity", ["root"], null, 0);
echo $t->plainTextToken;' | tail -n 1 | tr -d '\r')
[ -n "$token" ] || { echo "could not mint a reference API token" >&2; exit 1; }
printf 'REFERENCE_TOKEN=%s\n' "$token" >> "$OUT/reference.env"

node tools/parity/fixtures/apply.ts --base "$REFERENCE_URL" --token-env REFERENCE_TOKEN \
  --env-file "$OUT/reference.env" --fixtures tools/parity/fixtures/base.json \
  --out "$OUT/reference.ids.json"
