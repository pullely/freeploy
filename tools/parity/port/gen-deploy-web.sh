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
TAKE=$(node tools/parity/port/layout-take.ts "$R/$A" "$R/routes.web__profile/desktop-light.html" "$R/routes.web__dashboard/desktop-light.html")
gen "$A" --select body --inner --take "$TAKE" --after portal --name LayoutMarkup --slot 'main=!children' \
  --patch tools/parity/port/patches/AppShellMarkup.json --out "$L/LayoutMarkup.tsx"

# /profile: the page (inside the layout's width wrapper) and its own <body> overlays.
F=routes.web__profile/desktop-light.html
gen "$F" --select div.w-full.mx-auto --nth "$(node tools/parity/port/nth-main.ts "$R/$F")" --inner --name ProfileMarkup \
  --patch tools/parity/port/patches/ProfileMarkup.json --out "$P/ProfileMarkup.tsx"
gen "$F" --select body --inner --skip "$TAKE" --name ProfilePortalMarkup \
  --patch tools/parity/port/patches/ProfilePortalMarkup.json --out "$P/ProfilePortalMarkup.tsx"

# /profile/appearance: the page's own <body> overlays (the custom theme dialog).
gen "$A" --select body --inner --skip "$TAKE" --name AppearancePortalMarkup --out "$P/AppearancePortalMarkup.tsx"

# /user/confirm-password (Fortify password.confirm), guest-layout page.
gen routes.web__password.confirm/desktop-light.html --select main --name ConfirmPasswordMarkup \
  --slot 'form=alert' --handler 'form:onSubmit=onSubmit' --out "$P/ConfirmPasswordMarkup.tsx"

# /login, with Coolify's passkey sign-in (the reference is reached as localhost, where passkeys are offered).
gen routes.web__login/desktop-light.html --select main --name LoginMarkup --slot 'form=alert' --handler 'form:onSubmit=onSubmit' \
  --patch tools/parity/port/patches/LoginMarkup.json --out "$P/LoginMarkup.tsx"
