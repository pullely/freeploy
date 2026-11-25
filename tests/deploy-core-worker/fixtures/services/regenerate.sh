#!/usr/bin/env bash
# Regenerates every golden of the service catalogue and the Compose parser from Coolify's own PHP.
#
#   bash regenerate.sh <scratch copy of coollabsio/coolify@91b7e3e with vendor/ and a .env>
#
# The copy is written to (emit-catalogue.php runs Coolify's generator, which writes its two catalogue
# files into templates/), so it must not be a checkout you keep. See README.md for how to prepare it.
set -euo pipefail
root=$1
here=$(cd "$(dirname "$0")" && pwd)
yaml="$here/../compose-yaml"

php "$yaml/emit.php" "$root" "$yaml/cases.json" > "$yaml/goldens.json"
php "$here/emit-catalogue.php" "$root" > "$here/catalogue-golden.json"
php "$here/emit-select.php" "$root" > "$here/select-golden.json"

catalogue="$root/templates/service-templates-latest.json"
php "$here/emit.php" "$root" "$catalogue" | gzip -9n > "$here/goldens.json.gz"

# The server variants, for a selection of templates: proxies' exact labels and wildcard domains.
selection="umami appwrite supabase garage logto beszel rybbit pgadmin plane n8n wordpress-with-mysql immich formbricks appflowy glance wings litellm buzz authentik dify signoz pocketbase activepieces openpanel babybuddy docker-registry ente-photos-with-s3 uptime-kuma gitea nextcloud vaultwarden ghost mosquitto forgejo"
for variant in traefik-exact caddy-exact; do
  # shellcheck disable=SC2086 -- the selection is a list of names
  php "$here/emit.php" "$root" "$catalogue" "--variant=$variant" $selection | gzip -9n > "$here/goldens-$variant.json.gz"
done

# Editing a template's Compose file and saving it through StackForm (DP-66): the cases, then the goldens.
node "$here/gen-reparse-cases.mjs" "$catalogue" > "$here/reparse-cases.json"
php "$here/emit-reparse.php" "$root" "$catalogue" "$here/reparse-cases.json" | gzip -9n > "$here/reparse-goldens.json.gz"
