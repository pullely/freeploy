# Vendored Coolify views (for CSS class scanning only)

`views/` is a verbatim copy of `resources/views/**` from
coollabsio/coolify@91b7e3e (Apache-2.0). Nothing here is served or rendered.
Tailwind's `@source` in `src/css/app.css` scans these files, so deploy-web's
CSS carries exactly the utility classes Coolify's own build generates. The
React components in `src/` reuse those classes. See THIRD_PARTY_NOTICES.md.
