# Team audit log goldens (DP-75)

What Coolify's audit log records and shows for the team events Freeploy records too, so that the team
audit log (`apps/events-worker/src/team-audit-log.ts`) can be held to it (`src/team-audit-log.test.ts`).
Nothing in `emit.php` is a port: it signs a user in to Coolify's app and lets Coolify record.

| File | What it is |
|---|---|
| `emit.php` | asks Coolify and prints `goldens.json` |
| `goldens.json` | `emit.php`'s output. Never edited by hand. |

## What a golden holds

- `events["<resource>.<action>"]`: the `audit_events` row Coolify writes — `event`, `source`, `action`,
  `actor_type`, `actor_name`, `actor_email`, `resource_type`, `resource_name`, `description` — for:
  - the `Auditable` trait on `Team`: a team created, renamed and deleted (`ui.team.*`);
  - the team pages' `auditLog()` calls with the contexts Coolify passes: `Team\Member` (`ui.team_member.role_updated`,
    `ui.team_member.removed`), `Team\InviteLink` (`ui.team_invitation.created`), `Team\Invitations`
    (`ui.team_invitation.revoked`) and `Controller::acceptInvitation` (`ui.team_invitation.accepted`).
  The signed-in user is "Owner" (owner@example.com); the member is "Member".
- `headline`: `Str::headline()` of the words the page passes through it (actions, actor types, resources).

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a scratch copy you can write to (as for
`tests/policy-worker/fixtures/role-matrix`):

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php /path/to/freeploy/tests/events-worker/fixtures/audit-log/emit.php "$PWD" \
  > /path/to/freeploy/tests/events-worker/fixtures/audit-log/goldens.json
```

The clock is fixed (`2026-01-01T00:00:00Z`); nothing in the file is random, so a regeneration gives the
same file.
