<?php
// Asks Coolify's own policies (coollabsio/coolify@91b7e3e:app/Policies/**, Apache-2.0), through Laravel's
// Gate, what each team role may do, and prints goldens.json — nothing here is a port. Also prints what
// the team pages' validators answer (Team\Index, Team\InviteLink) and when an invitation expires
// (TeamInvitation::hasExpired), for the membership-worker's port.
// Usage (see README.md):
//
//   php emit.php <coolify root with vendor/ and a .env> > goldens.json
//
// Database: Coolify's `testing` connection (SQLite in memory) with all of Coolify's migrations. One team
// with three users: an owner, an admin and a member whose `team_user.access` is null (the default grants,
// AccessResolver::defaultMemberGrants(): team-wide Read). Coolify has no other team role at 91b7e3e
// (App\Enums\Role: member, admin, owner). The project and its environment are saved (the resolver reads
// them); the other models only need their team or environment and uuid, and are built in memory.
//
// Each check runs as Laravel runs a Livewire request: the user is signed in and the session's current
// team is the team (currentTeam(), User::role(), isAdmin()).

use App\Models\Application;
use App\Models\DiscordNotificationSettings;
use App\Models\EmailNotificationSettings;
use App\Models\Environment;
use App\Models\PrivateKey;
use App\Models\Project;
use App\Models\S3Storage;
use App\Models\Server;
use App\Models\Service;
use App\Models\StandalonePostgresql;
use App\Models\Team;
use App\Models\TeamInvitation;
use App\Models\User;
use App\Services\Access\AccessResolver;
use App\Support\ValidationPatterns;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

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

$team = Team::forceCreate(['name' => 'Matrix Team', 'personal_team' => false]);
$users = [];
foreach (['owner', 'admin', 'member'] as $role) {
    $user = User::forceCreate(['name' => ucfirst($role), 'email' => "$role@example.com", 'password' => bcrypt('password')]);
    $team->members()->attach($user->id, ['role' => $role, 'access' => null]);
    $users[$role] = $user->fresh();
}

$project = Project::forceCreate(['name' => 'Matrix', 'team_id' => $team->id, 'uuid' => 'matrix-project']);
$environment = Environment::where('project_id', $project->id)->firstOrFail();

$inMemory = function (string $class, array $attributes) {
    $model = new $class;
    $model->forceFill($attributes);

    return $model;
};
$server = $inMemory(Server::class, ['id' => 7, 'uuid' => 'matrix-server', 'team_id' => $team->id, 'ip' => '203.0.113.7', 'name' => 'matrix']);
$privateKey = $inMemory(PrivateKey::class, ['id' => 7, 'uuid' => 'matrix-key', 'team_id' => $team->id]);
$application = $inMemory(Application::class, ['id' => 7, 'uuid' => 'matrix-application', 'environment_id' => $environment->id]);
$database = $inMemory(StandalonePostgresql::class, ['id' => 7, 'uuid' => 'matrix-database', 'environment_id' => $environment->id]);
$service = $inMemory(Service::class, ['id' => 7, 'uuid' => 'matrix-service', 'environment_id' => $environment->id]);
$storage = $inMemory(S3Storage::class, ['id' => 7, 'uuid' => 'matrix-storage', 'team_id' => $team->id]);
$email = $inMemory(EmailNotificationSettings::class, ['id' => 7, 'team_id' => $team->id]);
$email->setRelation('team', $team);
$discord = $inMemory(DiscordNotificationSettings::class, ['id' => 8, 'team_id' => $team->id]);
$discord->setRelation('team', $team);

// [policy, ability, Gate arguments]. The abilities are every public method of the ten policies Freeploy
// ports pages of (app/Policies/{Server,PrivateKey,Project,Environment,Application,Database,Service,
// S3Storage,Notification,Team}Policy.php) except restore and forceDelete, which always answer false.
$abilities = [
    ['servers', 'viewAny', [Server::class]],
    ['servers', 'view', [$server]],
    ['servers', 'viewSharedVariables', [$server]],
    ['servers', 'create', [Server::class]],
    ['servers', 'placeResource', [$server]],
    ['servers', 'update', [$server]],
    ['servers', 'transfer', [$server]],
    ['servers', 'delete', [$server]],
    ['servers', 'manageProxy', [$server]],
    ['servers', 'manageSentinel', [$server]],
    ['servers', 'viewSentinel', [$server]],
    ['servers', 'manageCaCertificate', [$server]],
    ['servers', 'viewSecurity', [$server]],
    ['private-keys', 'viewAny', [PrivateKey::class]],
    ['private-keys', 'view', [$privateKey]],
    ['private-keys', 'create', [PrivateKey::class]],
    ['private-keys', 'update', [$privateKey]],
    ['private-keys', 'delete', [$privateKey]],
    ['projects', 'viewAny', [Project::class]],
    ['projects', 'view', [$project]],
    ['projects', 'viewSharedVariables', [$project]],
    ['projects', 'create', [Project::class]],
    ['projects', 'update', [$project]],
    ['projects', 'delete', [$project]],
    ['environments', 'viewAny', [Environment::class]],
    ['environments', 'view', [$environment]],
    ['environments', 'viewSharedVariables', [$environment]],
    ['environments', 'create', [Environment::class, $project]],
    ['environments', 'update', [$environment]],
    ['environments', 'delete', [$environment]],
    ['applications', 'viewAny', [Application::class]],
    ['applications', 'view', [$application]],
    ['applications', 'create', [Application::class, $environment]],
    ['applications', 'update', [$application]],
    ['applications', 'delete', [$application]],
    ['applications', 'uploadBackup', [$application]],
    ['applications', 'deploy', [$application]],
    ['applications', 'viewSensitive', [$application]],
    ['applications', 'manageEnvironment', [$application]],
    ['databases', 'viewAny', [StandalonePostgresql::class]],
    ['databases', 'view', [$database]],
    ['databases', 'create', [StandalonePostgresql::class, $environment]],
    ['databases', 'update', [$database]],
    ['databases', 'delete', [$database]],
    ['databases', 'manage', [$database]],
    ['databases', 'uploadBackup', [$database]],
    ['databases', 'manageBackups', [$database]],
    ['databases', 'viewSensitive', [$database]],
    ['databases', 'manageEnvironment', [$database]],
    ['services', 'viewAny', [Service::class]],
    ['services', 'view', [$service]],
    ['services', 'create', [Service::class, $environment]],
    ['services', 'update', [$service]],
    ['services', 'delete', [$service]],
    ['services', 'stop', [$service]],
    ['services', 'viewSensitive', [$service]],
    ['services', 'manageEnvironment', [$service]],
    ['services', 'uploadBackup', [$service]],
    ['services', 'deploy', [$service]],
    ['storages', 'viewAny', [S3Storage::class]],
    ['storages', 'view', [$storage]],
    ['storages', 'create', [S3Storage::class]],
    ['storages', 'update', [$storage]],
    ['storages', 'delete', [$storage]],
    ['storages', 'validateConnection', [$storage]],
    ['notifications', 'view', [$email]],
    ['notifications', 'update', [$email]],
    ['notifications', 'manage', [$discord]],
    ['notifications', 'sendTest', [$discord]],
    ['team', 'viewAny', [Team::class]],
    ['team', 'view', [$team]],
    ['team', 'viewSharedVariables', [$team]],
    ['team', 'create', [Team::class]],
    ['team', 'update', [$team]],
    ['team', 'delete', [$team]],
    ['team', 'manageMembers', [$team]],
    ['team', 'viewAdmin', [$team]],
    ['team', 'manageInvitations', [$team]],
];

$matrix = [];
foreach ($abilities as [$policy, $ability, $arguments]) {
    $row = [];
    foreach ($users as $role => $user) {
        app(AccessResolver::class)->flush();
        Auth::setUser($user);
        session(['currentTeam' => $team]);
        $row[$role] = Gate::forUser($user)->inspect($ability, $arguments)->allowed();
    }
    $matrix["$policy.$ability"] = $row;
}

// Team\Index::rules() and messages(); Team\InviteLink::rules() (Laravel's default messages).
$validate = function (array $data, array $rules, array $messages = [], array $attributes = []) {
    $validator = Validator::make($data, $rules, $messages, $attributes);

    return $validator->errors()->toArray();
};
$teamRules = ['name' => ValidationPatterns::nameRules(), 'description' => ValidationPatterns::descriptionRules()];
$teamMessages = array_merge(ValidationPatterns::combinedMessages(), ['name.required' => 'The Name field is required.']);
$teamAttributes = ['name' => 'name', 'description' => 'description'];
$teamCases = [
    'valid' => ['name' => "Parity User's Team", 'description' => null],
    'valid-description' => ['name' => 'Acme', 'description' => "Ops & dev (EU) - \"main\""],
    'empty-name' => ['name' => '', 'description' => null],
    'blank-name' => ['name' => '   ', 'description' => null],
    'short-name' => ['name' => 'ab', 'description' => null],
    'long-name' => ['name' => str_repeat('a', 256), 'description' => null],
    'max-name' => ['name' => str_repeat('a', 255), 'description' => null],
    'unicode-name' => ['name' => 'Équipe Ünïcødé', 'description' => null],
    'bad-name' => ['name' => 'Team <script>', 'description' => null],
    'bad-name-short' => ['name' => '<a', 'description' => null],
    'name-semicolon' => ['name' => 'Team; rm', 'description' => null],
    'name-apostrophe' => ['name' => "O'Brien", 'description' => null],
    'empty-description' => ['name' => 'Team', 'description' => ''],
    'long-description' => ['name' => 'Team', 'description' => str_repeat('d', 256)],
    'bad-description' => ['name' => 'Team', 'description' => 'a <b>bold</b> one'],
    'description-hash' => ['name' => 'Team', 'description' => 'Team #1'],
    'both-bad' => ['name' => '', 'description' => str_repeat('<', 300)],
];
$teamValidation = [];
foreach ($teamCases as $case => $data) {
    $teamValidation[$case] = ['input' => $data, 'errors' => (object) $validate($data, $teamRules, $teamMessages, $teamAttributes)];
}

$inviteRules = ['email' => 'required|email', 'role' => ['required', Rule::enum(\App\Enums\Role::class)]];
$inviteCases = [
    'valid' => ['email' => 'teammate@example.com', 'role' => 'member'],
    'valid-admin' => ['email' => 'Teammate@Example.com', 'role' => 'admin'],
    'valid-owner' => ['email' => 'a.b+c@example.co.uk', 'role' => 'owner'],
    'valid-no-tld' => ['email' => 'user@localhost', 'role' => 'member'],
    'empty' => ['email' => '', 'role' => ''],
    'no-at' => ['email' => 'teammate.example.com', 'role' => 'member'],
    'two-at' => ['email' => 'a@b@example.com', 'role' => 'member'],
    'space' => ['email' => 'team mate@example.com', 'role' => 'member'],
    'no-local' => ['email' => '@example.com', 'role' => 'member'],
    'no-domain' => ['email' => 'teammate@', 'role' => 'member'],
    'trailing-dot' => ['email' => 'teammate.@example.com', 'role' => 'member'],
    'double-dot' => ['email' => 'team..mate@example.com', 'role' => 'member'],
    'bad-role' => ['email' => 'teammate@example.com', 'role' => 'viewer'],
    'role-case' => ['email' => 'teammate@example.com', 'role' => 'Admin'],
    'builder-role' => ['email' => 'teammate@example.com', 'role' => 'builder'],
];
$inviteValidation = [];
foreach ($inviteCases as $case => $data) {
    $inviteValidation[$case] = ['input' => $data, 'errors' => (object) $validate($data, $inviteRules)];
}

// TeamInvitation::hasExpired(): created_at->diffInDays(now()) > constants.invitation.link.expiration_days.
$expiry = ['expiration_days' => config('constants.invitation.link.expiration_days'), 'cases' => []];
foreach ([0, 3600, 3 * 86400 - 1, 3 * 86400, 3 * 86400 + 1, 4 * 86400] as $age) {
    $invitation = new TeamInvitation;
    $invitation->created_at = Carbon::now()->subSeconds($age);
    $expiry['cases'][] = ['ageSeconds' => $age, 'expired' => $invitation->hasExpired()];
}

echo json_encode([
    'coolify' => '91b7e3e',
    'roles' => array_keys($users),
    'matrix' => $matrix,
    'teamValidation' => $teamValidation,
    'inviteValidation' => $inviteValidation,
    'invitationExpiry' => $expiry,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";
