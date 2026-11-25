# Role permission matrix goldens (DP-69)

What Coolify's own policies decide for each team role, so that Freeploy's roles can be held to them
ability by ability (`src/role-matrix.test.ts`), and what the team pages' validators answer
(`tests/membership-worker/src/team.test.ts`). Nothing in `emit.php` is a port: it builds a team in
Coolify's database and asks Laravel's Gate and Validator.

| File | What it is |
|---|---|
| `emit.php` | asks Coolify and prints `goldens.json` |
| `goldens.json` | `emit.php`'s output. Never edited by hand. |

## What a golden holds

- `matrix["<policy>.<ability>"]`: `{ owner, admin, member }`, `Gate::forUser($user)->inspect($ability, $arguments)->allowed()`
  for every public ability of the ten policies Freeploy ports pages of — `ServerPolicy`, `PrivateKeyPolicy`,
  `ProjectPolicy`, `EnvironmentPolicy`, `ApplicationPolicy`, `DatabasePolicy` (a `StandalonePostgresql`),
  `ServicePolicy`, `S3StoragePolicy`, `NotificationPolicy` (email and Discord settings) and `TeamPolicy` —
  except `restore` and `forceDelete`, which answer false to everyone. 78 abilities.
  The three users are the team's owner, admin and member; the member's `team_user.access` is null, so it has
  `AccessResolver::defaultMemberGrants()` (team-wide Read). Coolify has no other role at `91b7e3e`
  (`App\Enums\Role`: member, admin, owner; no viewer). Each check runs as a Livewire request does: the user
  signed in and the session's `currentTeam` the team.
- `teamValidation`: `Team\Index::rules()` with its `messages()` and attributes, for 17 inputs.
- `inviteValidation`: `Team\InviteLink::rules()` (Laravel's default messages), for 15 inputs.
- `invitationExpiry`: `TeamInvitation::hasExpired()` for invitations 0 s to 4 days old
  (`constants.invitation.link.expiration_days` = 3; Carbon 3's `diffInDays` is a float, so an invitation
  expires one second after 72 hours).

The test maps each ability to the action Freeploy's route asks policy-worker for and asks the policy-worker
for Freeploy's role of the same name (Coolify's member is Freeploy's `builder`). An ability whose route
Freeploy does not have yet is listed as skipped, with the reason, and counted as skipped.

Fixed, so that nothing needs masking: the clock (`2026-01-01T00:00:00Z`), the models' ids and uuids.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a scratch copy you can write to:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php /path/to/freeploy/tests/policy-worker/fixtures/role-matrix/emit.php "$PWD" \
  > /path/to/freeploy/tests/policy-worker/fixtures/role-matrix/goldens.json
```

The database is Coolify's `testing` connection (SQLite in memory, all migrations). The committed file was
emitted with PHP 8.3.6 (cli), Laravel 12.72.0 and Carbon 3.15.1. Nothing in it is random, so a
regeneration gives the same file.
