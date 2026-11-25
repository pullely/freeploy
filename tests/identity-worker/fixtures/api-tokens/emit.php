<?php
// What Coolify's API Tokens page (app/Livewire/Security/ApiTokens.php, coollabsio/coolify@91b7e3e,
// Apache-2.0) does with each case of cases.json — nothing in here is a port. See README.md.
//
//   DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=… DB_USERNAME=… DB_PASSWORD=… \
//     php emit.php <coolify root with vendor/ and a .env> cases.json > goldens.json
//
// The component runs as Livewire's test harness runs it (Livewire::test, signed in as the case's user with
// the team as the session's current team): mount(), the form's fields set, then the action. Emitted: the
// properties mount() set, the error bag, the toasts (`dispatch('error' | 'success')`), the issued token's
// shape, and the user's tokens afterwards (name, abilities, team, expiry).

use App\Livewire\Security\ApiTokens;
use App\Models\InstanceSettings;
use App\Models\PersonalAccessToken;
use App\Models\Team;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Queue;
use Livewire\Livewire;

$root = $argv[1];
$cases = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
foreach (['DB_CONNECTION' => 'pgsql', 'CACHE_DRIVER' => 'array', 'CACHE_STORE' => 'array', 'QUEUE_CONNECTION' => 'sync', 'SESSION_DRIVER' => 'array', 'APP_DEBUG' => 'false', 'APP_MAINTENANCE_STORE' => 'array', 'LOG_CHANNEL' => 'null'] as $key => $value) {
    putenv("$key=$value");
    $_ENV[$key] = $_SERVER[$key] = $value;
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
ob_start();
Artisan::call('migrate:fresh', ['--force' => true]);
ob_end_clean();
Bus::fake();
Queue::fake();
Notification::fake();
Carbon::setTestNow(Carbon::parse('2026-01-01T00:00:00Z'));

InstanceSettings::unguarded(fn () => InstanceSettings::query()->updateOrCreate(['id' => 0], ['is_api_enabled' => true]));
$team = Team::unguarded(fn () => Team::query()->forceCreate(['id' => 1, 'name' => 'Parity Team', 'personal_team' => false]));
DB::statement("SELECT setval(pg_get_serial_sequence('teams', 'id'), 1)");
$users = [];
foreach ($cases['users'] as $key => $u) {
    $user = User::query()->forceCreate(['name' => $u['name'], 'email' => $u['email'], 'password' => bcrypt('password'), 'current_team_id' => 1]);
    $user->teams()->attach(1, ['role' => $u['role']]);
    $users[$key] = $user;
}

$out = [];
foreach ($cases['cases'] as $case) {
    DB::beginTransaction();
    $user = $users[$case['user']]->fresh();
    Auth::login($user);
    session(['currentTeam' => $team->fresh()]);
    foreach ($case['existing'] ?? [] as $t) {
        $owner = $users[$t['user']];
        $owner->createToken($t['name'], $t['abilities'], null, 1);
    }
    $component = Livewire::test(ApiTokens::class);
    $mount = [];
    foreach (['canUseRootPermissions', 'canUseWritePermissions', 'canUseDeployPermissions', 'canUseSensitivePermissions', 'canUseDeletePermissions', 'canUseTeamScope', 'expirationOptions'] as $p) {
        $mount[$p] = $component->get($p);
    }
    $mount['form'] = ['description' => $component->get('form.description'), 'expiresInDays' => $component->get('form.expiresInDays'), 'permissions' => $component->get('form.permissions'), 'scopeMode' => $component->get('form.scopeMode')];
    foreach ($case['set'] ?? [] as $field => $value) {
        $component->set($field, $value);
    }
    $issued = null;
    $toasts = [];
    $errorBag = [];
    if (isset($case['call'])) {
        $args = $case['args'] ?? [];
        if (($case['call'] === 'revoke') && isset($case['revokeExisting'])) {
            $args = [PersonalAccessToken::query()->where('name', $case['revokeExisting'])->value('id')];
        }
        try {
            $component->call($case['call'], ...$args);
            $status = 200;
        } catch (\Symfony\Component\HttpKernel\Exception\HttpException $e) {
            $status = $e->getStatusCode();
        }
        foreach ($component->effects['dispatches'] ?? [] as $d) {
            if ($d['name'] === 'api-token-issued') {
                $issued = $d['params']['token'];
            } elseif (in_array($d['name'], ['error', 'success'], true)) {
                $toasts[] = [$d['name'], $d['params'][0] ?? null];
            }
        }
        $errorBag = $component->errors()->toArray();
    }
    $tokens = PersonalAccessToken::query()->where('tokenable_id', $user->id)->orderBy('id')->get()->map(fn ($t) => [
        'name' => $t->name,
        'abilities' => $t->abilities,
        'team_id' => $t->team_id,
        'expires_at' => $t->expires_at?->toIso8601String(),
        'scopes' => $t->scopes,
    ])->all();
    $out[] = [
        'name' => $case['name'],
        'mount' => $mount,
        'status' => $status ?? null,
        'errors' => $errorBag,
        'toasts' => $toasts,
        // Sanctum's "<id>|<40 random characters><crc32b of them>", given as its shape.
        'issued' => $issued === null ? null : [
            'id' => explode('|', $issued, 2)[0] === (string) PersonalAccessToken::query()->max('id'),
            'secretLength' => strlen(explode('|', $issued, 2)[1]),
            'crc' => hash('crc32b', substr(explode('|', $issued, 2)[1], 0, 40)) === substr(explode('|', $issued, 2)[1], 40),
        ],
        'tokens' => $tokens,
        'formAfter' => ['description' => $component->get('form.description'), 'expiresInDays' => $component->get('form.expiresInDays'), 'permissions' => $component->get('form.permissions')],
    ];
    Auth::logout();
    DB::rollBack();
}
echo json_encode(['coolify' => '91b7e3e', 'cases' => $out], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
