# API Tokens page goldens (DP-70)

What Coolify's Keys & Tokens → API Tokens page (`app/Livewire/Security/ApiTokens.php`) does with each case
of `cases.json`, so that identity-worker's tokens can be held to its rules and messages
(`src/api-tokens.test.ts`).

- `cases.json` — the users (owner, admin, member of one team) and the cases: the form's fields as the page
  sets them (`form.description`, `form.expiresInDays`, `form.permissions`) and the action (`addNewToken`,
  `revoke`), with tokens that exist before.
- `emit.php` — runs every case through Livewire's test harness (`Livewire::test(ApiTokens::class)`, signed
  in, the team as the session's current team) on PostgreSQL and prints what happened. Nothing in it is a port.
- `goldens.json` — its output: what `mount()` set, the error toasts (`handleError()` dispatches the
  ValidationException's message), whether a token was issued and its shape (`<id>|` and 40 random
  characters with their crc32b), and the user's tokens afterwards (name, abilities, team, expiry). Never
  edited by hand.

```sh
DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=<scratch db> DB_USERNAME=<user> DB_PASSWORD=<password> \
  php emit.php <scratch copy of coollabsio/coolify@91b7e3e> cases.json > goldens.json
```

The clock stands at 2026-01-01T00:00:00Z, so the expiry dates are exact.
