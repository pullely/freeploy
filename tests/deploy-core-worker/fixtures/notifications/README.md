# Notification payload goldens (DP-67)

What Coolify's own notification classes, channel classes and jobs produce, so that the TypeScript port in
`apps/deploy-core-worker/src/notifications/` can be held to it byte for byte
(`src/notification-payloads.test.ts`). Nothing in `emit.php` is a port: it builds Coolify's models from
the case's plain data and calls Coolify's code.

| File | What it is |
|---|---|
| `cases.mjs` | writes `cases.json`: `node cases.mjs cases.json` |
| `cases.json` | 83 cases over the 34 classes of `app/Notifications` that a team's channels send — every class has a plain case, and the edge cases its code branches on (no domain, no URL, no preview, a preview, a scan-gate block, a 5000-character error, names past every channel's length limit, text that needs Markdown/mrkdwn/HTML escaping, control characters, text outside ASCII) |
| `emit.php` | runs every case through Coolify and prints `goldens.json` |
| `resend-capture.php` | the Resend API for `emit.php`: a local `php -S` server that records the SDK's request |
| `goldens.json` | `emit.php`'s output. Never edited by hand. |

## What a golden holds

Per case (`goldens.json["<class>.<case>"].value`):

- `mail`: `toMail()`'s subject and view name; for `Test`, also the rendered HTML (`emails.test` in its layout).
- `discord`, `telegram`, `slack`, `pushover`, `webhook`: `toDiscord()->toPayload()`, `toTelegram()`,
  the SlackMessage's title/description/color, `toPushover()->toPayload(token, user)` and `toWebhook()`,
  each as `json_encode()` writes it with PHP's default flags (`\/`, `\uXXXX`) — what goes over the wire.
- `send`: the notification sent by its channel class (`DiscordChannel`, `TelegramChannel`, `SlackChannel`
  twice — a `hooks.slack.com` URL and a Mattermost URL —, `PushoverChannel`, `WebhookChannel`) to a team
  whose six channels are on and that has a Telegram topic id for every event. `Bus::fake()` keeps the job
  the channel dispatches; the job then runs against `Http::fake()`; every request it makes is recorded:
  method, URL, the headers Laravel's client sets (`Content-Type`, `User-Agent`), and the body as sent.
  Telegram's entry also has the thread id the channel chose. `Test.plain` has
  `telegram_button_fallback`: Telegram answers 400 "button url" and the job sends the text again with the
  links in it.
- `@resend`: the test email through Resend as `EmailChannel` sends it with a team's own settings, for five
  senders (plain, quoted name, non-ASCII name, the SMTP sender as fallback, no name): `mail_from_formatted()`
  and the Resend SDK's request (path, `Authorization`, `User-Agent: resend-php/1.18.0`, body).

Fixed, so that nothing needs masking: the clock (`2026-01-01T00:00:00Z`, Discord's `<t:1767225600:R>`),
the instance URL (`https://coolify.example.com`, `base_url()`), `APP_URL` and the URL generator's root
(`https://app.example.com`, `route()` links), `constants.coolify.version` (Discord's footer
`Coolify v4.7.6`), the fake tokens, and one DNS answer (93.184.216.34) for every webhook host
(`SafeWebhookUrl::resolveHostsUsing`).

The port is compared with a context that says what Coolify says (brand "Coolify", the same URLs, the
footer); Freeploy runs it with its own (`handlers/notifications.ts::freeployContext`).

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a scratch copy you can write to:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
node /path/to/freeploy/tests/deploy-core-worker/fixtures/notifications/cases.mjs /path/to/freeploy/tests/deploy-core-worker/fixtures/notifications/cases.json
php /path/to/freeploy/tests/deploy-core-worker/fixtures/notifications/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/notifications/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/notifications/goldens.json
```

The database is Coolify's `testing` connection (SQLite in memory, all migrations), for `base_url()` and
the rate limiter of `Reachable`/`Unreachable`; the models are built in memory with their relations set.
The committed file was emitted with PHP 8.3.6 (cli), Laravel 12.72.0, resend/resend-php 1.18.0 and
Coolify 4.7.6. A run takes about two seconds; nothing in it is random, so a regeneration gives the same
file.

## Inputs that are other parts of Coolify

The port takes, as plain data, what these return (the emitter answers them from the case):
`ScheduledVolumeBackup::targetResource()->name`, `targetType()`, `targetName()` and `resourceUrl()` (a
subclass), and `ExploitedProblemFound`'s properties (it is built without its constructor, which reads scan
findings from the database and keeps only scalars). `Database::link()` and `ScheduledTask::url()` are
ported and computed from the case's environment and project.

## Not covered

- The rendered email of every class but `Test`: the views are Blade with Markdown (CommonMark); the port
  has the subject and the view's name only. Cut in DP-67 (see IMPLEMENTATION-STATUS.md, Notes on DP9).
- The mail view data (`commit`, the why-lists of the image scan emails): it only feeds the HTML.
- The transactional emails (`TransactionalEmails/*`): they are the instance's, not a team channel's.
- `SslExpirationNotification` with resource names that PHP would turn into integer keys (`"1"`): PHP's
  array order and `json_encode` differ from a JS object's there.
