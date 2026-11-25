#!/usr/bin/env bash
# Compare deploy-web stage with the reference on this machine, without CI:
# reuse the reference capture of a CI run, capture stage here, compare.
#
#   tools/parity/local-stage.sh <run id | reference dir> [<route id regex>]
#
# The reference capture comes from a CI run's artefact (downloaded with gh), or
# from a directory that already holds one (…/tools/parity/out/reference).
# The stage user's credentials come from LOCAL_EMAIL / LOCAL_PASSWORD in the
# environment if set, else from the macOS keychain (service
# freeploy-parity-local); never from a file. Pixel ratios from a Mac
# differ from CI's Linux fonts; the DOM/copy comparison is exact either way.
set -euo pipefail
run="${1:?parity run id to take the reference capture from}"
only="${2:-}"
cd "$(dirname "$0")/../.."
if [ -d "$run" ]; then
  work="${TMPDIR:-/tmp}/freeploy-local-parity/local"
  mkdir -p "$work" && rm -rf "$work/ref" && ln -s "$(cd "$run" && pwd)" "$work/ref"
else
  work="${TMPDIR:-/tmp}/freeploy-local-parity/$run"
fi
if [ ! -e "$work/ref" ]; then
  mkdir -p "$work/ref"
  gh run download "$run" -R pullely/freeploy -D "$work/ref" >/dev/null
fi
ref=$(dirname "$(find -L "$work/ref" -path '*tools/parity/out/reference/capture.json' | head -1)")
[ -f "$ref/capture.json" ] || { echo "no reference capture in run $run" >&2; exit 1; }
out="$work/out"
rm -rf "$out" && mkdir -p "$out" && cp -R "$ref" "$out/reference"
export PARITY_CHANNEL="${PARITY_CHANNEL:-chrome}"
export LOCAL_EMAIL="${LOCAL_EMAIL:-parity-local@example.com}"
if [ -z "${LOCAL_PASSWORD:-}" ]; then
  LOCAL_PASSWORD=$(security find-generic-password -s freeploy-parity-local -a "$LOCAL_EMAIL" -w)
fi
export LOCAL_PASSWORD
cd tools/parity
node visual/capture.ts --system target --base "${PARITY_TARGET_URL:-https://freeploy-deploy-web-stage.nexo-7be.workers.dev}" \
  --user-env LOCAL_EMAIL --password-env LOCAL_PASSWORD --routes ../../specs/epics/freeploy-coolify-parity/parity/routes.web.json \
  --out "$out" ${only:+--only "$only"}
node visual/compare.ts --out "$out" --report "$out/visual-report.json" >/dev/null || true
jq -r '.routes[] | select(.status != "missing") | [.id, .status, (.worstRatio * 1000 | floor / 10 | tostring) + "%", ([.shots[].dom.fieldDiff] | max | tostring) + " fields", ((.shots[0].dom.missingText // []) | length | tostring) + " missing text"] | @tsv' "$out/visual-report.json"
echo "report: $out/visual-report.json"
