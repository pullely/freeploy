#!/usr/bin/env bash
# Reuse the reference capture of an earlier successful parity run when nothing
# that shapes the reference changed: the pinned Coolify commit, the harness
# that builds, seeds and captures it, and the route inventory. The reference is
# deterministic in those inputs, so its capture is the same; only Freeploy's
# side is captured again. Sets reuse=true|false in $GITHUB_OUTPUT.
#
# Needs GH_TOKEN (actions: read). Writes $OUT/reference-key.txt either way, so
# a full run's artifact can be reused by later ones.
set -euo pipefail
OUT="${OUT:-tools/parity/out}"
mkdir -p "$OUT"
key=$( {
  echo "$COOLIFY_REF"
  git ls-files -s tools/parity/reference tools/parity/fixtures tools/parity/visual/capture.ts \
    tools/parity/visual/masks.ts tools/parity/visual/paths.ts tools/parity/commands tools/parity/api \
    tools/parity/behaviour specs/epics/freeploy-coolify-parity/parity/routes.web.json
} | sha256sum | cut -c1-32)
echo "$key" > "$OUT/reference-key.txt"
echo "reference key: $key"

reuse=false
if [ "${PARITY_FULL:-}" != "true" ]; then
  for run in $(gh run list -R "$GITHUB_REPOSITORY" --workflow parity --status success --limit 15 --json databaseId --jq '.[].databaseId'); do
    tmp=$(mktemp -d)
    if gh run download "$run" -R "$GITHUB_REPOSITORY" -D "$tmp" >/dev/null 2>&1; then
      found=$(find "$tmp" -path '*tools/parity/out/reference-key.txt' | head -1)
      if [ -n "$found" ] && [ "$(cat "$found")" = "$key" ]; then
        base=$(dirname "$found")
        cp -R "$base/reference" "$OUT/reference"
        for f in goldens.reference.json api-report.reference.json reference.ids.json; do
          [ -f "$base/$f" ] && cp "$base/$f" "$OUT/$f"
        done
        [ -d "$base/behaviour" ] && cp -R "$base/behaviour" "$OUT/behaviour"
        echo "reusing the reference capture of run $run"
        echo "$run" > "$OUT/reference-reused-from.txt"
        reuse=true
        rm -rf "$tmp"
        break
      fi
    fi
    rm -rf "$tmp"
  done
fi
echo "reuse=$reuse" >> "${GITHUB_OUTPUT:-/dev/null}"
