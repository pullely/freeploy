#!/usr/bin/env bash
# Compare deploy-web stage with the reference on this machine, without CI:
# reuse the reference capture of a CI run, capture stage here, compare.
#
#   tools/parity/local-stage.sh <run id> [<route id regex>]
#
# The stage user's credentials are read from the macOS keychain
# (service freeploy-parity-local), never from a file. Pixel ratios from a Mac
# differ from CI's Linux fonts; the DOM/copy comparison is exact either way.
set -euo pipefail
run="${1:?parity run id to take the reference capture from}"
only="${2:-}"
cd "$(dirname "$0")/../.."
work="${TMPDIR:-/tmp}/freeploy-local-parity/$run"
if [ ! -d "$work/ref" ]; then
  mkdir -p "$work/ref"
  gh run download "$run" -R pullely/freeploy -D "$work/ref" >/dev/null
fi
ref=$(dirname "$(find "$work/ref" -path '*tools/parity/out/reference/capture.json' | head -1)")
out="$work/out"
rm -rf "$out" && mkdir -p "$out" && cp -R "$ref" "$out/reference"
export LOCAL_EMAIL=parity-local@example.com
LOCAL_PASSWORD=$(security find-generic-password -s freeploy-parity-local -a "$LOCAL_EMAIL" -w)
export LOCAL_PASSWORD
cd tools/parity
node visual/capture.ts --system target --base "${PARITY_TARGET_URL:-https://freeploy-deploy-web-stage.nexo-7be.workers.dev}" \
  --user-env LOCAL_EMAIL --password-env LOCAL_PASSWORD --routes ../../specs/epics/freeploy-coolify-parity/parity/routes.web.json \
  --out "$out" ${only:+--only "$only"}
node visual/compare.ts --out "$out" --report "$out/visual-report.json" >/dev/null || true
jq -r '.routes[] | select(.status != "missing") | [.id, .status, (.worstRatio * 1000 | floor / 10 | tostring) + "%", ([.shots[].dom.fieldDiff] | max | tostring) + " fields", ((.shots[0].dom.missingText // []) | length | tostring) + " missing text"] | @tsv' "$out/visual-report.json"
echo "report: $out/visual-report.json"
