<?php
// Asks Coolify (coollabsio/coolify@91b7e3e, Apache-2.0) what its audit log records and shows for the team
// events Freeploy also records, and prints goldens.json — nothing here is a port. Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> > goldens.json
//
// Database: Coolify's `testing` connection (SQLite in memory) with all of Coolify's migrations. A user
// "Owner" (owner@example.com) is signed in, as in a Livewire request, and does what the team pages do:
// creates, renames and deletes a team (the Auditable trait records ui.team.*), and the team pages'
// auditLog() calls run with the contexts Coolify passes them (Team\Member, Team\InviteLink,
// Team\Invitations, Controller::acceptInvitation). Each row is read back from audit_events.
// `headline` is Str::headline() for the words the audit log page passes through it.

use App\Models\AuditEvent;
use App\Models\Team;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

[$root] = [$argv[1]];
foreach (['DB_CONNECTION' => 'testing', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
Artisan::call('migrate', ['--force' => true]);
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));

$owner = User::forceCreate(['name' => 'Owner', 'email' => 'owner@example.com', 'password' => bcrypt('password')]);
$member = User::forceCreate(['name' => 'Member', 'email' => 'member@example.com', 'password' => bcrypt('password')]);
Auth::login($owner);

$rows = [];
$last = function (string $label) use (&$rows): void {
    $event = AuditEvent::query()->latest('id')->firstOrFail();
    $rows[$label] = [
        'event' => $event->event,
        'source' => $event->source,
        'action' => $event->action,
        'actor_type' => $event->actor_type,
        'actor_name' => $event->actor_name,
        'actor_email' => $event->actor_email,
        'resource_type' => $event->resource_type,
        'resource_name' => $event->resource_name,
        'description' => $event->description,
    ];
};

// The Auditable trait on Team: created, updated (a rename), deleted.
$team = Team::forceCreate(['name' => 'Acme', 'personal_team' => false]);
$last('team.created');
$team->update(['name' => 'Acme Inc']);
$last('team.updated');
$teamId = $team->id;

// The team pages' auditLog() calls, with the contexts Coolify passes.
auditLog('ui.team_member.role_updated', ['team_id' => $teamId, 'member_id' => $member->id, 'member_name' => $member->name, 'role' => 'admin']);
$last('team_member.role_updated');
auditLog('ui.team_member.removed', ['team_id' => $teamId, 'member_id' => $member->id, 'member_name' => $member->name]);
$last('team_member.removed');
auditLog('ui.team_invitation.created', ['team_id' => $teamId, 'invitation_uuid' => 'inv1', 'invitation_email' => 'new@example.com', 'role' => 'member', 'via' => 'link', 'access' => null]);
$last('team_invitation.created');
auditLog('ui.team_invitation.revoked', ['team_id' => $teamId, 'invitation_uuid' => 'inv1', 'invitation_email' => 'new@example.com']);
$last('team_invitation.revoked');
auditLog('ui.team_invitation.accepted', ['team_id' => $teamId, 'invitation_uuid' => 'inv2', 'invitation_email' => 'owner@example.com', 'role' => 'member', 'via' => 'link', 'already_member' => false, 'member_id' => $owner->id, 'member_name' => $owner->name]);
$last('team_invitation.accepted');

$team->delete();
$last('team.deleted');

$words = ['created', 'updated', 'deleted', 'removed', 'role_updated', 'revoked', 'accepted', 'added', 'archived', 'rotated', 'secret_rotated',
    'delivery_succeeded', 'action_recorded', 'access_denied', 'paid', 'recorded', 'failed', 'activated', 'canceled', 'enabled', 'disabled',
    'user', 'api_token', 'system', 'webhook', 'mcp', 'scheduler', 'team_member', 'team_invitation', 'team', 'changed_fields', 'description', 'name'];
$headline = [];
foreach ($words as $word) {
    $headline[$word] = Str::headline($word);
}

echo json_encode([
    'coolify' => '91b7e3e',
    'events' => $rows,
    'headline' => $headline,
    'upper' => ['ui' => Str::upper('ui'), 'api' => Str::upper('api')],
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
