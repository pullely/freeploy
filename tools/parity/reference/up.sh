#!/usr/bin/env bash
# Bring up the reference Coolify at COOLIFY_REF on this machine (a CI runner
# with Docker), the way scripts/install.sh lays it out, but from source at the
# pinned commit rather than from a published release (91b7e3e is v4.7.6+182,
# unreleased). Prints the base URL on success.
#
# Inputs (env):
#   COOLIFY_DIR   checkout of coollabsio/coolify at COOLIFY_REF (required)
#   COOLIFY_REF   the pinned commit, used as the image tag (default: HEAD of COOLIFY_DIR)
#   APP_PORT      host port for the UI (default 8000)
#   ROOT_USER_EMAIL / ROOT_USER_PASSWORD  the fixture root user (generated if unset)
#   OUT           directory for state the later steps read (default tools/parity/out)
#
# Secrets: every password and key here is generated per run, is fake, and is
# written only to $OUT/reference.env (git-ignored, mode 0600) and the
# throwaway /data/coolify tree on the runner.
set -euo pipefail

: "${COOLIFY_DIR:?set COOLIFY_DIR to a coolify checkout}"
COOLIFY_REF="${COOLIFY_REF:-$(git -C "$COOLIFY_DIR" rev-parse --short=7 HEAD)}"
APP_PORT="${APP_PORT:-8000}"
OUT="${OUT:-tools/parity/out}"
mkdir -p "$OUT"
umask 077

if [ -z "${ROOT_USER_PASSWORD:-}" ]; then
  # Coolify's RootUserSeeder requires mixed case, a number and a symbol, and
  # checks HaveIBeenPwned, so a fresh random value is used every run.
  ROOT_USER_PASSWORD="Fp-$(openssl rand -hex 12)-X9!"
fi
ROOT_USER_EMAIL="${ROOT_USER_EMAIL:-root@example.com}"

image="docker.io/coollabsio/coolify:${COOLIFY_REF}"
dockerfile="$COOLIFY_DIR/docker/production/Dockerfile"
# BUILD-ENVIRONMENT FALLBACK, not an app change. The Dockerfile fetches
# nginx.org's apk signing key at build time; on 2026-11-23 that URL answered
# 404 (upstream main has the same line). When it does not answer, the build
# uses the same key vendored here — byte-identical to every archived copy
# from 2019 to 2026-10 — checked by its sha256, and says so.
NGINX_KEY_URL=https://nginx.org/keys/nginx_signing.rsa.pub
NGINX_KEY_SHA256=ff7cf138acc09f2a5029300ab713fe6a1440605fca72e2bab76a4da9206fec87
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$NGINX_KEY_URL")" != "200" ]; then
  echo "::warning::$NGINX_KEY_URL is not answering; building with the vendored key (sha256 $NGINX_KEY_SHA256)"
  echo "$NGINX_KEY_SHA256  $here/nginx_signing.rsa.pub" | sha256sum -c - >/dev/null
  key_b64="$(base64 -w0 "$here/nginx_signing.rsa.pub")"
  patched="$OUT/Dockerfile.reference"
  sed "s#curl -fsSL $NGINX_KEY_URL -o /etc/apk/keys/nginx_signing.rsa.pub#echo $key_b64 | base64 -d > /etc/apk/keys/nginx_signing.rsa.pub#g" "$dockerfile" > "$patched"
  grep -q "$NGINX_KEY_URL" "$patched" && { echo "could not patch the key fetch" >&2; exit 1; }
  dockerfile="$patched"
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "building $image from source (docker/production/Dockerfile)"
  docker build -q -f "$dockerfile" \
    --build-arg COOLIFY_VERSION="$COOLIFY_REF" \
    --build-arg GIT_SHA="$COOLIFY_REF" \
    -t "$image" "$COOLIFY_DIR"
fi

sudo mkdir -p /data/coolify/{source,ssh/keys,ssh/mux,applications,databases,backups,services,proxy/dynamic,webhooks-during-maintenance,sentinel}
sudo cp "$COOLIFY_DIR/docker-compose.yml" "$COOLIFY_DIR/docker-compose.prod.yml" /data/coolify/source/
sudo cp "$COOLIFY_DIR/.env.production" /data/coolify/source/.env

set_env() { # key value — replace or append in /data/coolify/source/.env
  sudo KEY="$1" VALUE="$2" awk 'BEGIN{done=0} index($0, ENVIRON["KEY"] "=")==1 && !done {$0=ENVIRON["KEY"] "=" ENVIRON["VALUE"]; done=1} {print} END{if(!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]}' \
    /data/coolify/source/.env | sudo tee /data/coolify/source/.env.tmp >/dev/null
  sudo mv /data/coolify/source/.env.tmp /data/coolify/source/.env
}
set_env APP_ID "$(openssl rand -hex 16)"
set_env APP_KEY "base64:$(openssl rand -base64 32)"
set_env DB_PASSWORD "$(openssl rand -hex 24)"
set_env REDIS_PASSWORD "$(openssl rand -hex 24)"
set_env PUSHER_APP_ID "$(openssl rand -hex 32)"
set_env PUSHER_APP_KEY "$(openssl rand -hex 32)"
set_env PUSHER_APP_SECRET "$(openssl rand -hex 32)"
set_env PUSHER_BACKEND_PORT "6001"
set_env ROOT_USERNAME "'Parity Root'"
set_env ROOT_USER_EMAIL "'$ROOT_USER_EMAIL'"
set_env ROOT_USER_PASSWORD "'$ROOT_USER_PASSWORD'"
set_env AUTOUPDATE "false"
# Operator config, not an app change: the contract run makes ~700 API calls a
# minute from one IP, and the default limit (200/min, config/api.php) would
# answer most of them with 429.
set_env API_RATE_LIMIT "100000"
set_env LATEST_IMAGE "$COOLIFY_REF"
set_env APP_PORT "$APP_PORT"

# The SSH key Coolify uses to manage its own host ("localhost" server).
if [ ! -f /data/coolify/ssh/keys/id.root@host.docker.internal ]; then
  sudo ssh-keygen -q -f /data/coolify/ssh/keys/id.root@host.docker.internal -t ed25519 -N '' -C root@coolify
  sudo mkdir -p /root/.ssh
  sudo sh -c 'cat /data/coolify/ssh/keys/id.root@host.docker.internal.pub >> /root/.ssh/authorized_keys'
fi
sudo chown -R 9999:root /data/coolify
sudo chmod -R 700 /data/coolify

docker network inspect coolify >/dev/null 2>&1 || docker network create --attachable coolify >/dev/null

src=/data/coolify/source
sudo env LATEST_IMAGE="$COOLIFY_REF" docker compose --project-directory "$src" \
  --env-file "$src/.env" -f "$src/docker-compose.yml" -f "$src/docker-compose.prod.yml" \
  up -d --remove-orphans --wait --wait-timeout 600

base="http://127.0.0.1:${APP_PORT}"
for _ in $(seq 1 90); do
  if curl -fsS "$base/api/health" >/dev/null 2>&1; then break; fi
  sleep 5
done
curl -fsS "$base/api/health" >/dev/null

cat > "$OUT/reference.env" <<EOF
REFERENCE_URL=$base
REFERENCE_EMAIL=$ROOT_USER_EMAIL
REFERENCE_PASSWORD=$ROOT_USER_PASSWORD
COOLIFY_REF=$COOLIFY_REF
EOF
echo "$base"
