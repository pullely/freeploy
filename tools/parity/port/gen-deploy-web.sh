#!/usr/bin/env bash
# Regenerate deploy-web's generated markup from a parity run's reference capture.
#   tools/parity/port/gen-deploy-web.sh <out/reference dir>
set -euo pipefail
R="${1:?reference capture dir}"
cd "$(dirname "$0")/../../.."
gen() { node tools/parity/port/html2tsx.ts --html "$R/$1" --source "$1" "${@:2}"; }
L=apps/deploy-web/src/layout/generated
P=apps/deploy-web/src/pages/generated
A=routes.web__profile.appearance/desktop-light.html
# The signed-in layout: everything Coolify's layouts put in <body> (overlays,
# popups, modals, the shell), up to where a page's own teleported overlays begin.
gen "$A" --select body --inner --take 32 --after portal --name LayoutMarkup --slot 'main=!children' \
  --patch tools/parity/port/patches/AppShellMarkup.json --out "$L/LayoutMarkup.tsx"
