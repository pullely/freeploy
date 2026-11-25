<?php
// Runs every case of cases.json through Coolify's own notification classes, channels and jobs
// (coollabsio/coolify@91b7e3e, Apache-2.0) and prints goldens.json — nothing here is a port.
// Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// Database: Coolify's `testing` connection (SQLite in memory) with all of Coolify's migrations, for
// base_url() (the instance settings row) and the rate limiter of Reachable/Unreachable. The models a
// notification reads are built in memory from the case's plain data, with their relations set.
//
// Per case and channel:
//   mail      toMail(): its subject and view name (the rendered HTML only for Test, see README.md)
//   discord   toDiscord()->toPayload()            json_encode() with PHP's default flags
//   telegram  toTelegram()                        json_encode()
//   slack     toSlack(): title, description, color
//   pushover  toPushover()->toPayload(token, user)
//   webhook   toWebhook()
//   requests  the channel class sends the notification to a team whose six channels are on (Bus::fake()
//             keeps the job it dispatches); the job then runs against Http::fake(), and every request it
//             makes is recorded: method, URL, the headers Laravel's client sets, and the body as sent.
//
// Fixed: the clock (2026-01-01T00:00:00Z), the instance URL (https://coolify.example.com), APP_URL
// (https://app.example.com), the version (config constants.coolify.version), the fake tokens below, and
// a DNS answer of 93.184.216.34 for every webhook host (SafeWebhookUrl::resolveHostsUsing).

use App\Jobs\SendMessageToDiscordJob;
use App\Jobs\SendMessageToPushoverJob;
use App\Jobs\SendMessageToSlackJob;
use App\Jobs\SendMessageToTelegramJob;
use App\Jobs\SendWebhookJob;
use App\Models\Application;
use App\Models\ApplicationDeploymentQueue;
use App\Models\ApplicationPreview;
use App\Models\DiscordNotificationSettings;
use App\Models\EmailNotificationSettings;
use App\Models\Environment;
use App\Models\InstanceSettings;
use App\Models\PersonalAccessToken;
use App\Models\Project;
use App\Models\PushoverNotificationSettings;
use App\Models\S3Storage;
use App\Models\ScheduledDatabaseBackup;
use App\Models\ScheduledTask;
use App\Models\ScheduledVolumeBackup;
use App\Models\ScheduledVolumeBackupExecution;
use App\Models\Server;
use App\Models\Service;
use App\Models\ServiceApplication;
use App\Models\ServiceDatabase;
use App\Models\SlackNotificationSettings;
use App\Models\StandalonePostgresql;
use App\Models\Team;
use App\Models\TelegramNotificationSettings;
use App\Models\WebhookNotificationSettings;
use App\Notifications\Channels\DiscordChannel;
use App\Notifications\Channels\PushoverChannel;
use App\Notifications\Channels\SlackChannel;
use App\Notifications\Channels\TelegramChannel;
use App\Notifications\Channels\WebhookChannel;
use App\Rules\SafeWebhookUrl;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Http;

[$root, $casesFile] = [$argv[1], $argv[2]];
foreach (['DB_CONNECTION' => 'testing', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

Artisan::call('migrate', ['--force' => true]);
config(['app.url' => 'https://app.example.com', 'app.name' => 'Coolify']);
// route() links (Database::link()) start with APP_URL too.
Illuminate\Support\Facades\URL::forceRootUrl('https://app.example.com');
Illuminate\Support\Facades\URL::forceScheme('https');
InstanceSettings::forceCreate(['id' => 0, 'fqdn' => 'https://coolify.example.com']);
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));
\Carbon\CarbonImmutable::setTestNow(\Carbon\CarbonImmutable::parse('2026-01-01T00:00:00Z'));
SafeWebhookUrl::resolveHostsUsing(fn (string $host): array => ['93.184.216.34']);

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/FAKE-DISCORD-TOKEN';
const SLACK_URL = 'https://hooks.slack.com/services/T00000000/B00000000/FAKE-SLACK-TOKEN';
const MATTERMOST_URL = 'https://mattermost.example.com/hooks/FAKE-MATTERMOST-KEY';
const TELEGRAM_TOKEN = '123456:FAKE-TELEGRAM-TOKEN';
const TELEGRAM_CHAT = '-1001234567890';
const PUSHOVER_TOKEN = 'FAKE-PUSHOVER-API-TOKEN';
const PUSHOVER_USER = 'FAKE-PUSHOVER-USER-KEY';
const WEBHOOK_URL = 'https://hooks.example.com/coolify?token=FAKE-WEBHOOK-TOKEN';

// ---------------------------------------------------------------------------------------------------
// Models from plain data.

function environmentModel(?array $e): ?Environment
{
    if ($e === null) {
        return null;
    }
    $environment = (new Environment)->setRawAttributes(['uuid' => $e['uuid'], 'name' => $e['name'] ?? null]);
    if (isset($e['project'])) {
        $environment->setRelation('project', (new Project)->setRawAttributes(['uuid' => $e['project']['uuid'], 'name' => $e['project']['name'] ?? null]));
    }

    return $environment;
}

/** An Application whose gitCommitLink() is not asked: no case has a deployment with a commit. */
function applicationModel(array $a): Application
{
    $application = (new Application)->setRawAttributes(array_filter([
        'uuid' => $a['uuid'],
        'name' => $a['name'] ?? null,
        'fqdn' => $a['fqdn'] ?? null,
        'git_branch' => $a['git_branch'] ?? null,
        'max_restart_count' => $a['max_restart_count'] ?? null,
        'restart_count' => $a['restart_count'] ?? null,
    ], fn ($v) => $v !== null));
    $application->setRelation('environment', environmentModel($a['environment'] ?? null));

    return $application;
}

function serverModel(array $s): Server
{
    $server = (new Server)->setRawAttributes(['uuid' => $s['uuid'], 'name' => $s['name'], 'id' => 1]);
    if (array_key_exists('outdatedInfo', $s)) {
        $server->outdatedInfo = $s['outdatedInfo'];
    }

    return $server;
}

function resourceModel(array $r): object
{
    switch ($r['type']) {
        case 'application':
            return applicationModel($r);
        case 'database':
            $db = (new StandalonePostgresql)->setRawAttributes(['uuid' => $r['uuid'], 'name' => $r['name'], 'restart_count' => $r['restart_count'], 'max_restart_count' => $r['max_restart_count']]);
            $db->setRelation('environment', environmentModel($r['environment']));

            return $db;
        case 'preview':
            $preview = (new ApplicationPreview)->setRawAttributes(['uuid' => $r['uuid'], 'pull_request_id' => $r['pull_request_id'], 'fqdn' => $r['fqdn'], 'restart_count' => $r['restart_count'], 'max_restart_count' => $r['max_restart_count']]);
            $preview->setRelation('application', applicationModel($r['application']));

            return $preview;
        case 'service_application':
            $part = (new ServiceApplication)->setRawAttributes(['uuid' => $r['uuid'], 'name' => $r['name'], 'fqdn' => $r['fqdn'], 'restart_count' => $r['restart_count'], 'max_restart_count' => $r['max_restart_count']]);
            $service = (new Service)->setRawAttributes(['uuid' => $r['service']['uuid']]);
            $service->setRelation('environment', environmentModel($r['service']['environment']));
            $part->setRelation('service', $service);

            return $part;
    }
    throw new RuntimeException("resource type {$r['type']}");
}

function databaseModel(array $d): StandalonePostgresql
{
    $db = (new StandalonePostgresql)->setRawAttributes(['uuid' => $d['uuid'], 'name' => $d['name']]);
    $db->setRelation('environment', environmentModel($d['environment']));

    return $db;
}

function taskModel(array $t): ScheduledTask
{
    $task = new ScheduledTask;
    $task->setRawAttributes(['uuid' => $t['uuid'], 'name' => $t['name'], 'consecutive_failures' => $t['consecutive_failures'], 'disabled_reason' => $t['disabled_reason']]);
    $task->failing_since = $t['failing_since'];
    $application = isset($t['application']) ? applicationModel($t['application']) : null;
    $service = null;
    if (isset($t['service'])) {
        $service = (new Service)->setRawAttributes(['uuid' => $t['service']['uuid']]);
        $service->setRelation('environment', environmentModel($t['service']['environment']));
    }
    $task->setRelation('application', $application);
    $task->setRelation('service', $service);

    return $task;
}

/** A volume backup whose target is given by the case: what targetResource(), targetType(), targetName() and resourceUrl() answer. */
function volumeBackupModel(array $b): ScheduledVolumeBackup
{
    $backup = new class extends ScheduledVolumeBackup
    {
        public array $fixture = [];

        public function targetResource(): ?Illuminate\Database\Eloquent\Model
        {
            return $this->fixture['resourceName'] === null ? null : (new Application)->setRawAttributes(['name' => $this->fixture['resourceName']]);
        }

        public function targetType(): string
        {
            return $this->fixture['targetType'];
        }

        public function targetName(): string
        {
            return $this->fixture['targetName'];
        }

        public function resourceUrl(): ?string
        {
            return $this->fixture['resourceUrl'];
        }
    };
    $backup->fixture = $b;
    $backup->setRawAttributes(['uuid' => $b['uuid'], 'frequency' => $b['frequency'], 'missing_backup_notification_days' => $b['missing_backup_notification_days']]);

    return $backup;
}

function notificationFor(array $case): object
{
    $in = $case['input'];
    $ns = 'App\\Notifications\\';
    switch ($case['class']) {
        case 'Test':
            return new App\Notifications\Test(ping: $in['ping']);
        case 'DeploymentSuccess':
        case 'DeploymentFailed':
            $application = applicationModel($in['application']);
            $preview = $in['preview'] === null ? null : (new ApplicationPreview)->setRawAttributes($in['preview']);
            $deployment = null;
            if ($in['deployment'] !== null) {
                $deployment = new ApplicationDeploymentQueue;
                $deployment->deployment_uuid = $in['deployment_uuid'];
                $deployment->scan_gate_result = $in['deployment']['scan_gate_result'] ?? null;
            }
            if ($deployment === null && $case['class'] === 'DeploymentFailed') {
                // The constructor looks the deployment up by uuid; an unsaved one with the same uuid answers the same.
                $deployment = new ApplicationDeploymentQueue;
                $deployment->deployment_uuid = $in['deployment_uuid'];
            }
            $class = $ns.'Application\\'.$case['class'];

            return new $class($application, $in['deployment_uuid'], $preview, $deployment);
        case 'RestartLimitReached':
        case 'StatusChanged':
            $class = $ns.'Application\\'.$case['class'];

            return new $class(resourceModel($in['resource']));
        case 'ContainerRestarted':
            return new App\Notifications\Container\ContainerRestarted($in['name'], serverModel($in['server']), $in['url']);
        case 'BackupFailed':
            return new App\Notifications\Database\BackupFailed((new ScheduledDatabaseBackup)->setRawAttributes($in['backup']), databaseModel($in['database']), $in['output'], $in['database_name']);
        case 'BackupMissing':
            $backup = (new ScheduledDatabaseBackup)->setRawAttributes(array_diff_key($in['backup'], ['database' => 1]));
            $backup->setRelation('database', $in['backup']['database'] === null ? null : (new StandalonePostgresql)->setRawAttributes($in['backup']['database']));

            return new App\Notifications\Database\BackupMissing($backup, $in['last_execution_at'] === null ? null : Carbon::parse($in['last_execution_at']));
        case 'BackupSuccess':
            return new App\Notifications\Database\BackupSuccess((new ScheduledDatabaseBackup)->setRawAttributes($in['backup']), databaseModel($in['database']), $in['database_name']);
        case 'BackupSuccessWithS3Warning':
            $backup = (new ScheduledDatabaseBackup)->setRawAttributes(['frequency' => $in['backup']['frequency']]);
            $backup->setRelation('s3', $in['backup']['s3'] === null ? null : (new S3Storage)->setRawAttributes($in['backup']['s3']));

            return new App\Notifications\Database\BackupSuccessWithS3Warning($backup, databaseModel($in['database']), $in['database_name'], $in['s3_error']);
        case 'TaskSuccess':
            return new App\Notifications\ScheduledTask\TaskSuccess(taskModel($in['task']), $in['output']);
        case 'TaskFailed':
            return new App\Notifications\ScheduledTask\TaskFailed(taskModel($in['task']), $in['output'], $in['disabled']);
        case 'DockerCleanupFailed':
        case 'DockerCleanupSuccess':
            $class = $ns.'Server\\'.$case['class'];

            return new $class(serverModel($in['server']), $in['message']);
        case 'ForceDisabled':
        case 'ForceEnabled':
        case 'HostKeyChanged':
        case 'Reachable':
        case 'Unreachable':
            $class = $ns.'Server\\'.$case['class'];

            return new $class(serverModel($in['server']));
        case 'HetznerDeletionFailed':
            return new App\Notifications\Server\HetznerDeletionFailed($in['hetznerServerId'], $in['teamId'], $in['errorMessage']);
        case 'HighDiskUsage':
            return new App\Notifications\Server\HighDiskUsage(serverModel($in['server']), $in['disk_usage'], $in['server_disk_usage_notification_threshold']);
        case 'ServerPatchCheck':
            return new App\Notifications\Server\ServerPatchCheck(serverModel($in['server']), $in['patchData']);
        case 'TraefikVersionOutdated':
            return new App\Notifications\Server\TraefikVersionOutdated(collect(array_map(serverModel(...), $in['servers'])));
        case 'SslExpirationNotification':
            return new App\Notifications\SslExpirationNotification(array_map(databaseModel(...), $in['resources']));
        case 'ApiTokenExpiringNotification':
            $token = (new PersonalAccessToken)->setRawAttributes(['name' => $in['token']['name']]);
            $token->expires_at = $in['token']['expires_at'];

            return new App\Notifications\ApiTokenExpiringNotification($token);
        case 'ApiTokenFailingNotification':
            return new App\Notifications\ApiTokenFailingNotification((new PersonalAccessToken)->setRawAttributes(['name' => $in['token']['name']]), $in['failedRequests'], $in['lastRequest']);
        case 'ScheduledJobRecovered':
            return new App\Notifications\ScheduledJobRecovered($in['failureEvent'], $in['title'], $in['webhookEvent'], $in['url'], $in['webhookData']);
        case 'GeneralNotification':
            return new App\Notifications\Internal\GeneralNotification($in['message'], $in['success']);
        case 'VolumeBackupSuccess':
            return new App\Notifications\VolumeBackup\BackupSuccess(volumeBackupModel($in['backup']), $in['warning'], $in['uploadFailed']);
        case 'VolumeBackupFailed':
            return new App\Notifications\VolumeBackup\BackupFailed(volumeBackupModel($in['backup']), $in['output']);
        case 'VolumeBackupMissing':
            return new App\Notifications\VolumeBackup\BackupMissing(volumeBackupModel($in['backup']), $in['last_execution_at'] === null ? null : Carbon::parse($in['last_execution_at']));
        case 'VolumeBackupRecoveryFailed':
            $execution = (new ScheduledVolumeBackupExecution)->setRawAttributes(['uuid' => $in['execution']['uuid'], 'recovery_error' => $in['execution']['recovery_error'], 'stop_recovery_pending' => $in['execution']['stop_recovery_pending']]);
            $execution->setRelation('scheduledVolumeBackup', $in['execution']['backup'] === null ? null : volumeBackupModel($in['execution']['backup']));

            return new App\Notifications\VolumeBackup\RecoveryFailed($execution);
        case 'ExploitedProblemFound':
            // The constructor reads scan findings from the database; the notification keeps only these scalars.
            $notification = (new ReflectionClass(App\Notifications\ImageScan\ExploitedProblemFound::class))->newInstanceWithoutConstructor();
            foreach (['resourceName', 'resourceUuid', 'url', 'count', 'exploited', 'action', 'checkIncomplete'] as $property) {
                $notification->{$property} = $in[$property];
            }
            $notification->why = [];

            return $notification;
        case 'VulnerabilityDigest':
            return new App\Notifications\ImageScan\VulnerabilityDigest($in['digest']);
    }
    throw new RuntimeException("class {$case['class']}");
}

// ---------------------------------------------------------------------------------------------------
// The team the channels send to: every channel on, a thread id for every Telegram event.

function team(string $slackUrl = SLACK_URL): Team
{
    $team = (new Team)->setRawAttributes(['id' => 1, 'name' => 'Fixture Team']);
    $discord = new DiscordNotificationSettings;
    $discord->forceFill(['id' => 1, 'team_id' => 1, 'discord_enabled' => true, 'discord_webhook_url' => DISCORD_URL, 'discord_ping_enabled' => true, 'failure_count' => 0]);
    $discord->exists = true;
    $slack = new SlackNotificationSettings;
    $slack->forceFill(['id' => 1, 'team_id' => 1, 'slack_enabled' => true, 'slack_webhook_url' => $slackUrl, 'failure_count' => 0]);
    $slack->exists = true;
    $telegram = new TelegramNotificationSettings;
    $telegram->forceFill(['id' => 1, 'team_id' => 1, 'telegram_enabled' => true, 'telegram_token' => TELEGRAM_TOKEN, 'telegram_chat_id' => TELEGRAM_CHAT, 'failure_count' => 0]);
    foreach (['deployment_success', 'deployment_failure', 'status_change', 'restart_limit_reached', 'backup_success', 'backup_failure', 'scheduled_task_success', 'scheduled_task_failure', 'docker_cleanup_success', 'docker_cleanup_failure', 'server_disk_usage', 'server_reachable', 'server_unreachable', 'server_patch', 'traefik_outdated', 'image_vulnerabilities'] as $event) {
        $telegram->{"telegram_notifications_{$event}_thread_id"} = "thread-{$event}";
    }
    $telegram->exists = true;
    $pushover = new PushoverNotificationSettings;
    $pushover->forceFill(['id' => 1, 'team_id' => 1, 'pushover_enabled' => true, 'pushover_user_key' => PUSHOVER_USER, 'pushover_api_token' => PUSHOVER_TOKEN, 'failure_count' => 0]);
    $pushover->exists = true;
    $webhook = new WebhookNotificationSettings;
    $webhook->forceFill(['id' => 1, 'team_id' => 1, 'webhook_enabled' => true, 'webhook_url' => WEBHOOK_URL, 'failure_count' => 0]);
    $webhook->exists = true;
    $email = new EmailNotificationSettings;
    $email->forceFill(['id' => 1, 'team_id' => 1, 'deployment_commit_details_email_notifications' => false]);
    $team->setRelation('discordNotificationSettings', $discord);
    $team->setRelation('slackNotificationSettings', $slack);
    $team->setRelation('telegramNotificationSettings', $telegram);
    $team->setRelation('pushoverNotificationSettings', $pushover);
    $team->setRelation('webhookNotificationSettings', $webhook);
    $team->setRelation('emailNotificationSettings', $email);

    return $team;
}

function recorded(): array
{
    return Http::recorded()->map(function (array $pair): array {
        /** @var ClientRequest $request */
        $request = $pair[0];
        $headers = [];
        foreach (['Content-Type', 'User-Agent', 'Authorization', 'Accept'] as $name) {
            if ($request->hasHeader($name)) {
                $headers[$name] = $request->header($name)[0];
            }
        }

        return ['method' => $request->method(), 'url' => $request->url(), 'headers' => $headers, 'body' => $request->body()];
    })->values()->all();
}

/** Send through the channel class, keep the job it dispatched, run the job against a fake HTTP server. */
function requestsThrough(string $channelClass, string $jobClass, object $notification, Team $team, array $fakeResponses = []): array
{
    Bus::fake();
    (new $channelClass)->send($team, $notification);
    $jobs = Bus::dispatched($jobClass);
    if ($jobs->isEmpty()) {
        return [];
    }
    $job = $jobs->last();
    Http::fake($fakeResponses + ['*' => Http::response(['ok' => true, 'id' => 'msg_1'], 200)]);
    if ($job instanceof SendMessageToTelegramJob) {
        $job->sendMessage();
        $extra = ['thread' => $job->threadId];
    } else {
        $job->handle();
        $extra = [];
    }
    $requests = recorded();
    // A fresh factory, so the next case records only its own requests.
    Http::swap(new Illuminate\Http\Client\Factory);

    return $extra + ['requests' => $requests];
}

function json(mixed $value): string
{
    return json_encode($value, JSON_THROW_ON_ERROR);
}

// ---------------------------------------------------------------------------------------------------

$cases = json_decode(file_get_contents($casesFile), true, flags: JSON_THROW_ON_ERROR)['cases'];
$out = [];
foreach ($cases as $case) {
    try {
        $team = team();
        $n = notificationFor($case);
        $golden = [];
        if (method_exists($n, 'toMail')) {
            $mail = $n->toMail($team);
            $golden['mail'] = ['subject' => $mail->subject, 'view' => $mail->view];
            if ($case['class'] === 'Test') {
                $golden['mail']['html'] = (string) $mail->render();
            }
        }
        $golden['discord'] = json($n->toDiscord()->toPayload());
        $golden['telegram'] = json($n->toTelegram($team));
        $slack = $n->toSlack();
        $golden['slack'] = json(['title' => $slack->title, 'description' => $slack->description, 'color' => $slack->color]);
        $golden['pushover'] = json($n->toPushover()->toPayload(PUSHOVER_TOKEN, PUSHOVER_USER));
        $golden['webhook'] = json($n->toWebhook());
        $golden['send'] = [
            'discord' => requestsThrough(DiscordChannel::class, SendMessageToDiscordJob::class, $n, $team),
            'telegram' => requestsThrough(TelegramChannel::class, SendMessageToTelegramJob::class, $n, $team),
            'slack' => requestsThrough(SlackChannel::class, SendMessageToSlackJob::class, $n, $team),
            'mattermost' => requestsThrough(SlackChannel::class, SendMessageToSlackJob::class, $n, team(MATTERMOST_URL)),
            'pushover' => requestsThrough(PushoverChannel::class, SendMessageToPushoverJob::class, $n, $team),
            'webhook' => requestsThrough(WebhookChannel::class, SendWebhookJob::class, $n, $team),
        ];
        if ($case['id'] === 'Test.plain') {
            // Telegram cannot open a button URL: the job sends the text again with the links in it.
            $golden['send']['telegram_button_fallback'] = requestsThrough(TelegramChannel::class, SendMessageToTelegramJob::class, $n, $team, [
                'api.telegram.org/*' => Http::sequence()
                    ->push(['ok' => false, 'error_code' => 400, 'description' => 'Bad Request: BUTTON_URL_INVALID button url is invalid'], 400)
                    ->push(['ok' => true], 200),
            ]);
        }
        $out[$case['id']] = ['ok' => true, 'value' => $golden];
    } catch (Throwable $e) {
        $out[$case['id']] = ['ok' => false, 'error' => get_class($e).': '.$e->getMessage().' @ '.$e->getFile().':'.$e->getLine()];
    }
}

// The test email through Resend, as EmailChannel sends it with the team's own settings: the Resend SDK's
// request to a local capture of the API (RESEND_BASE_URL), for senders that need quoting, a fallback to
// the SMTP sender, and none (then the name is Coolify).
$capture = tempnam(sys_get_temp_dir(), 'resend');
$port = 18000 + random_int(0, 999);
$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__.'/resend-capture.php'], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, ['RESEND_CAPTURE_FILE' => $capture]);
for ($i = 0; $i < 50 && @fsockopen('127.0.0.1', $port) === false; $i++) {
    usleep(100000);
}
putenv("RESEND_BASE_URL=http://127.0.0.1:{$port}");
$senders = [
    'named' => ['resend_from_name' => 'Fixture Team', 'resend_from_address' => 'alerts@example.com'],
    'quoted' => ['resend_from_name' => 'Fixture, "Ops" Team', 'resend_from_address' => 'alerts@example.com'],
    'unicode' => ['resend_from_name' => 'Équipe 🚀', 'resend_from_address' => 'alerts@example.com'],
    'smtp-fallback' => ['resend_from_name' => '', 'resend_from_address' => null, 'smtp_from_name' => 'SMTP Sender', 'smtp_from_address' => 'smtp@example.com'],
    'no-name' => ['resend_from_name' => null, 'resend_from_address' => 'alerts@example.com'],
];
$resend = [];
foreach ($senders as $id => $sender) {
    file_put_contents($capture, '');
    $settings = new EmailNotificationSettings;
    $settings->forceFill(['resend_enabled' => true, 'resend_api_key' => 're_FAKE_RESEND_KEY', ...$sender]);
    $mail = (new App\Notifications\Test('someone@example.com', 'email'))->toMail();
    Resend::client($settings->resend_api_key)->emails->send([
        'from' => mail_from_formatted($settings, false),
        'to' => ['someone@example.com'],
        'subject' => $mail->subject,
        'html' => (string) $mail->render(),
    ]);
    $request = json_decode(trim(file_get_contents($capture)), true);
    $headers = [];
    foreach (['Content-Type', 'User-Agent', 'Authorization', 'Accept'] as $name) {
        if (isset($request['headers'][$name])) {
            $headers[$name] = $request['headers'][$name];
        }
    }
    $resend[$id] = ['from' => mail_from_formatted($settings, false), 'method' => $request['method'], 'path' => $request['path'], 'headers' => $headers, 'body' => $request['body']];
}
proc_terminate($server);
unlink($capture);
$out['@resend'] = ['ok' => true, 'value' => $resend];

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
