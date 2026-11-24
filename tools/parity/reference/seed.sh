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

# The regular user's password: generated here, kept in $OUT/reference.env only.
PARITY_USER_PASSWORD="Fp-$(openssl rand -hex 12)-U7!"
printf 'REFERENCE_USER_EMAIL=user@example.com\nREFERENCE_USER_PASSWORD=%s\n' "$PARITY_USER_PASSWORD" >> "$OUT/reference.env"
token=$(docker exec -e PARITY_USER_PASSWORD="$PARITY_USER_PASSWORD" coolify php artisan tinker --execute '
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
\App\Models\Team::find(0)->forceFill(["show_boarding" => false])->save();
// The capture and the fixtures use a regular user in their own team, because
// that is what every Freeploy tenant is: Coolify gives a registered user the
// personal team "<name> + s Team" (app/Models/User.php created hook) and no
// instance-admin surfaces. Root stays the instance admin for DP12 pages.
$u = \App\Models\User::create(["name" => "Parity User", "email" => "user@example.com", "password" => \Illuminate\Support\Facades\Hash::make(getenv("PARITY_USER_PASSWORD"))]);
$u->forceFill(["email_verified_at" => now()])->save();
$team = $u->teams()->first();
$team->forceFill(["show_boarding" => false])->save();
// Its own "localhost" server: the same host and SSH key as the root team uses
// for the runner, so deployments in the behaviour scenarios land on the runner.
$root = \App\Models\Server::find(0);
$key = \App\Models\PrivateKey::find($root->private_key_id)->replicate(["uuid", "fingerprint"]);
$key->team_id = $team->id; $key->name = "localhost"; $key->save();
$server = \App\Models\Server::create(["name" => "localhost", "description" => $root->description, "ip" => $root->ip, "port" => $root->port, "user" => $root->user, "team_id" => $team->id, "private_key_id" => $key->id]);
$server->settings->forceFill(["is_reachable" => true, "is_usable" => true])->save();
$t = $u->createToken("parity", ["root"], null, $team->id);
echo $t->plainTextToken;' | tail -n 1 | tr -d '\r')
[ -n "$token" ] || { echo "could not mint a reference API token" >&2; exit 1; }
printf 'REFERENCE_TOKEN=%s\n' "$token" >> "$OUT/reference.env"

node tools/parity/fixtures/apply.ts --base "$REFERENCE_URL" --token-env REFERENCE_TOKEN \
  --env-file "$OUT/reference.env" --fixtures tools/parity/fixtures/base.json \
  --out "$OUT/reference.ids.json"
