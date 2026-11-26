// Writes cases.json: the fixture and the requests emit.php sends to Coolify's /api/v1 and
// tests/deploy-core-worker/src/api-v1.test.ts replays against Freeploy's (see README.md).
//
//   node cases.mjs > cases.json
import { readFileSync } from "node:fs";

const T1 = 1; // the fixture's team ("Parity Team")
const T2 = 2; // another team, which the tokens of team 1 must never see

const P_ALPHA = "p1alphaprojectuuid000001";
const P_BETA = "p2betaprojectuuid0000002";
const P_OTHER = "p3otherprojectuuid000003";
const E_PROD = "e1alphaproduction0000001";
const E_STAGING = "e2alphastaging0000000002";
const E_BETA = "e3betaproduction00000003";
const E_OTHER = "e4otherproduction0000004";
const K_MAIN = "k1parityprivatekey000001";
const K_FREE = "k2unusedprivatekey000002";
const K_OTHER = "k3otherteamkey0000000003";
const S_MAIN = "s1parityserveruuid000001";
const S_OTHER = "s2otherteamserver0000002";
const D_MAIN = "d1paritydestination00001";
const D_OTHER = "d2otherdestination000002";
const A_IMAGE = "a1parityimageapp00000001";
const A_GIT = "a2paritygitapp0000000002";
const A_OTHER = "a3otherteamapp0000000003";
const V_FOO = "v1parityfoovariable00001";
const V_SECRET = "v2paritysecretvariable02";
const V_MULTI = "v3paritymultilinevar0003";
const V_OTHER = "v4otherteamvariable00004";
/** Fixed manual webhook secrets (Coolify's creating hook makes random ones; both sides are given these). */
const webhookSecrets = (prefix) => Object.fromEntries(["github", "gitlab", "bitbucket", "gitea"].map((p) => [`manual_webhook_secret_${p}`, `${prefix}${p}`.padEnd(40, "x")]));

const fixture = {
  teams: [
    { id: T1, name: "Parity Team", description: null, personal_team: false },
    { id: T2, name: "Other Team", description: "Not yours", personal_team: false },
  ],
  users: [
    { id: 1, name: "Parity Owner", email: "owner@example.com", teams: [{ team: T1, role: "owner" }] },
    { id: 2, name: "Parity Member", email: "member@example.com", teams: [{ team: T1, role: "member" }] },
    { id: 3, name: "Other Owner", email: "other@example.com", teams: [{ team: T2, role: "owner" }] },
    { id: 4, name: "Parity Admin", email: "admin@example.com", teams: [{ team: T1, role: "admin" }] },
  ],
  projects: [
    { id: 1, uuid: P_ALPHA, name: "Alpha", description: "The first project", team: T1, environments: [
      { id: 1, uuid: E_PROD, name: "production", description: null },
      { id: 2, uuid: E_STAGING, name: "staging", description: "Before production" },
    ] },
    { id: 2, uuid: P_BETA, name: "Beta", description: null, team: T1, environments: [{ id: 3, uuid: E_BETA, name: "production", description: null }] },
    { id: 3, uuid: P_OTHER, name: "Other", description: null, team: T2, environments: [{ id: 4, uuid: E_OTHER, name: "production", description: null }] },
  ],
  privateKeys: [
    { id: 1, uuid: K_MAIN, name: "Parity Key", description: "The fixture's key", file: "../ssh-keys/ed25519.openssh", team: T1 },
    { id: 2, uuid: K_FREE, name: "Unused Key", description: null, file: "../ssh-keys/ecdsa256.openssh", team: T1 },
    { id: 3, uuid: K_OTHER, name: "Other Key", description: null, file: "../ssh-keys/rsa2048.openssh", team: T2 },
  ],
  servers: [
    { id: 1, uuid: S_MAIN, name: "parity-server", description: "The fixture server", ip: "203.0.113.10", user: "root", port: 22, team: T1, private_key_id: 1 },
    { id: 2, uuid: S_OTHER, name: "other-server", description: null, ip: "203.0.113.20", user: "root", port: 22, team: T2, private_key_id: 3 },
  ],
  // The default destination each server's created hook makes (Coolify gives it a random uuid; the fixture fixes it).
  destinations: [
    { id: 1, uuid: D_MAIN, server_id: 1 },
    { id: 2, uuid: D_OTHER, server_id: 2 },
  ],
  // Applications as Freeploy's creation stores them (insertDockerImageApplication, insertBuiltApplication); Coolify's
  // fixture saves the same columns through its model, so its creating and created hooks run (the settings row, Nixpacks'
  // NIXPACKS_NODE_VERSION).
  applications: [
    { id: 1, uuid: A_IMAGE, team: T1, environment_id: 1, destination_id: 1, name: "parity-image", fqdn: "https://image.example.com",
      columns: { repository_project_id: 0, git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage", ports_exposes: "80", docker_registry_image_name: "nginx", docker_registry_image_tag: "alpine", health_check_enabled: false, ...webhookSecrets("image") } },
    { id: 2, uuid: A_GIT, team: T1, environment_id: 1, destination_id: 1, name: "parity-git", fqdn: null,
      columns: { git_repository: "coollabsio/coolify-examples", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000", base_directory: "/", source_id: 0, source_type: "App\\Models\\GithubApp", ...webhookSecrets("git") } },
    { id: 3, uuid: A_OTHER, team: T2, environment_id: 4, destination_id: 2, name: "other-image", fqdn: null,
      columns: { repository_project_id: 0, git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage", ports_exposes: "80", docker_registry_image_name: "redis", docker_registry_image_tag: "7", health_check_enabled: false, ...webhookSecrets("other") } },
  ],
  // Variables made through the model (EnvironmentVariable::create(), whose created hook adds an application's preview copy).
  variables: [
    { uuid: V_FOO, application: 1, key: "FOO", value: "bar", is_literal: false, is_multiline: false, is_shown_once: false, is_runtime: true, is_buildtime: true, comment: null },
    { uuid: V_SECRET, application: 1, key: "SECRET_TOKEN", value: "s3cr3t-value", is_literal: true, is_multiline: false, is_shown_once: true, is_runtime: true, is_buildtime: false, comment: "Shown once" },
    { uuid: V_MULTI, application: 1, key: "MULTI", value: "line one\nline two", is_literal: false, is_multiline: true, is_shown_once: false, is_runtime: false, is_buildtime: true, comment: null },
    { uuid: V_OTHER, application: 3, key: "OTHER", value: "theirs", is_literal: false, is_multiline: false, is_shown_once: false, is_runtime: true, is_buildtime: true, comment: null },
  ],
  // secret: what follows "<id>|" in the bearer token (Sanctum's 40 random characters and crc32b).
  tokens: [
    { key: "root", id: 1, user: 1, team: T1, name: "Root token", abilities: ["root"], secret: "rootrootrootrootrootrootrootrootrootroot5a1b2c3d" },
    { key: "read", id: 2, user: 1, team: T1, name: "Read token", abilities: ["read"], secret: "readreadreadreadreadreadreadreadreadread0a1b2c3d" },
    { key: "sensitive", id: 3, user: 1, team: T1, name: "Sensitive token", abilities: ["read", "read:sensitive"], secret: "senssenssenssenssenssenssenssenssenssens1a1b2c3d" },
    { key: "write", id: 4, user: 1, team: T1, name: "Write token", abilities: ["read", "write"], secret: "writwritwritwritwritwritwritwritwritwrit2a1b2c3d" },
    { key: "writeOnly", id: 5, user: 1, team: T1, name: "Write only", abilities: ["write"], secret: "wonlwonlwonlwonlwonlwonlwonlwonlwonlwonl3a1b2c3d" },
    { key: "delete", id: 6, user: 1, team: T1, name: "Delete token", abilities: ["read", "delete"], secret: "deledeledeledeledeledeledeledeledeledele4a1b2c3d" },
    { key: "expired", id: 7, user: 1, team: T1, name: "Expired token", abilities: ["root"], secret: "expiexpiexpiexpiexpiexpiexpiexpiexpiexpi5a1b2c3d", expires_at: "2025-12-31 00:00:00" },
    { key: "memberRead", id: 8, user: 2, team: T1, name: "Member read", abilities: ["read"], secret: "mreamreamreamreamreamreamreamreamreamrea6a1b2c3d" },
    { key: "memberWrite", id: 9, user: 2, team: T1, name: "Member write", abilities: ["read", "write"], secret: "mwrimwrimwrimwrimwrimwrimwrimwrimwrimwri7a1b2c3d" },
    { key: "notMember", id: 10, user: 1, team: T2, name: "Not a member", abilities: ["root"], secret: "nmemnmemnmemnmemnmemnmemnmemnmemnmemnmem8a1b2c3d" },
    { key: "memberSensitive", id: 11, user: 2, team: T1, name: "Member sensitive", abilities: ["read", "read:sensitive"], secret: "msenmsenmsenmsenmsenmsenmsenmsenmsenmsen9a1b2c3d" },
  ],
};

const cases = [];
/** A case's bodyFile fields are read into its body here (base64 for those listed in `base64`), so the JSON both sides send is in cases.json. */
const add = (c) => {
  if (c.bodyFile) {
    for (const [field, file] of Object.entries(c.bodyFile)) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      c.body[field] = c.base64?.includes(field) ? Buffer.from(text).toString("base64") : text;
    }
    delete c.bodyFile;
    delete c.base64;
  }
  cases.push(c);
};

// ── authentication, the token's team, abilities, ApiAllowed ──────────────────
add({ name: "auth: no token", method: "GET", path: "/api/v1/projects" });
add({ name: "auth: unknown token", method: "GET", path: "/api/v1/projects", authorization: "Bearer 99|nopenopenopenopenopenopenopenopenopenope00000000" });
add({ name: "auth: secret without id", method: "GET", path: "/api/v1/projects", authorization: `Bearer ${fixture.tokens[0].secret}` });
add({ name: "auth: not a bearer", method: "GET", path: "/api/v1/projects", authorization: "Basic dXNlcjpwYXNz" });
add({ name: "auth: expired", token: "expired", method: "GET", path: "/api/v1/projects" });
add({ name: "auth: team the user left", token: "notMember", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: read token writes", token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } });
add({ name: "ability: write-only token reads", token: "writeOnly", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: write token deletes", token: "write", method: "DELETE", path: `/api/v1/projects/${P_BETA}` });
add({ name: "ability: member token beyond the member's access", token: "memberWrite", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: member read token", token: "memberRead", method: "GET", path: "/api/v1/projects" });
add({ name: "allowed: API disabled", token: "root", method: "GET", path: "/api/v1/projects", instance: { is_api_enabled: false } });
add({ name: "allowed: IP not in the allow list", token: "root", method: "GET", path: "/api/v1/projects", instance: { allowed_ips: "198.51.100.0/24,192.0.2.7" } });
add({ name: "allowed: IP in a CIDR of the allow list", token: "root", method: "GET", path: "/api/v1/projects", ip: "198.51.100.23", instance: { allowed_ips: "198.51.100.0/24, 192.0.2.7" } });
add({ name: "allowed: IP exact in the allow list", token: "root", method: "GET", path: "/api/v1/projects", ip: "192.0.2.7", instance: { allowed_ips: "198.51.100.0/24,192.0.2.7" } });
add({ name: "allowed: allow list 0.0.0.0", token: "root", method: "GET", path: "/api/v1/projects", instance: { allowed_ips: "0.0.0.0" } });
add({ name: "route: unknown, with a token", token: "root", method: "GET", path: "/api/v1/nonexistent" });
add({ name: "route: unknown, without a token", method: "GET", path: "/api/v1/nonexistent" });
add({ name: "route: wrong method", token: "root", method: "PUT", path: "/api/v1/projects" });
add({ name: "health", method: "GET", path: "/api/v1/health" });
add({ name: "health: unversioned", method: "GET", path: "/api/health" });
add({ name: "version", token: "read", method: "GET", path: "/api/v1/version" });

// ── the two rate limiters ───────────────────────────────────────────────────
add({ name: "rate limit: API_RATE_LIMIT reached", config: { rate_limit: 3 }, sequence: [
  { token: "read", method: "GET", path: "/api/v1/version" },
  { token: "read", method: "GET", path: "/api/v1/projects" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { token: "read", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version", ip: "203.0.113.51" },
  { advance: 61, token: "read", method: "GET", path: "/api/v1/version" },
] });
add({ name: "failed requests: blocked after the limit", config: { failed_request_rate_limit: 3 }, sequence: [
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/health" },
  { advance: 61, method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { advance: 301, token: "read", method: "GET", path: "/api/v1/version" },
] });
add({ name: "failed requests: per token, and a 404 with a token does not count", config: { failed_request_rate_limit: 2 }, sequence: [
  { token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } },
  { token: "read", method: "GET", path: "/api/v1/nonexistent" },
  { token: "read", method: "GET", path: `/api/v1/projects/nonexistentuuid` },
  { token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } },
  { token: "read", method: "GET", path: "/api/v1/version" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/nonexistent" },
] });

// ── teams ───────────────────────────────────────────────────────────────────
for (const [p, label] of [["/api/v1/team", "current team"], ["/api/v1/teams/current", "current team (deprecated alias)"], ["/api/v1/teams", "teams"], [`/api/v1/teams/${T1}`, "team by id"]]) {
  add({ name: `teams: ${label}`, token: "read", method: "GET", path: p });
}
add({ name: "teams: another team by id", token: "read", method: "GET", path: `/api/v1/teams/${T2}` });
add({ name: "teams: members", token: "read", method: "GET", path: "/api/v1/team/members" });
add({ name: "teams: members (deprecated alias)", token: "read", method: "GET", path: "/api/v1/teams/current/members" });
add({ name: "teams: members by id", token: "read", method: "GET", path: `/api/v1/teams/${T1}/members` });
add({ name: "teams: members of another team", token: "read", method: "GET", path: `/api/v1/teams/${T2}/members` });

// ── projects and environments ───────────────────────────────────────────────
add({ name: "projects: list", token: "read", method: "GET", path: "/api/v1/projects" });
add({ name: "projects: show", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}` });
add({ name: "projects: show another team's", token: "read", method: "GET", path: `/api/v1/projects/${P_OTHER}` });
add({ name: "projects: environments", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/environments` });
add({ name: "projects: environments of an unknown project", token: "read", method: "GET", path: "/api/v1/projects/nonexistentuuid/environments" });
add({ name: "projects: create", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "Gamma", description: "Made by the API" },
  after: { projects: "select name, description, team_id from projects where name = 'Gamma'", environments: "select e.name from environments e join projects p on p.id = e.project_id where p.name = 'Gamma'" } });
add({ name: "projects: create without a description", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" }, after: { projects: "select name, description from projects where name = 'Gamma'" } });
add({ name: "projects: create, trimmed", token: "root", method: "POST", path: "/api/v1/projects", body: { name: "  Spaced  ", description: "" }, after: { projects: "select name, description from projects where name like '%Spaced%'" } });
add({ name: "projects: create, name not a string", token: "write", method: "POST", path: "/api/v1/projects", body: { name: 12345, description: ["x"] } });
add({ name: "projects: create, invalid", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "x", description: "<b>", extra: 1 } });
add({ name: "projects: create, no name", token: "write", method: "POST", path: "/api/v1/projects", body: { description: "No name" } });
add({ name: "projects: create, not JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "name=Gamma", contentType: "application/x-www-form-urlencoded" });
add({ name: "projects: create, invalid JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "{name" });
add({ name: "projects: create, empty JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "{}" });
add({ name: "projects: update", token: "write", method: "PATCH", path: `/api/v1/projects/${P_BETA}`, body: { name: "Beta 2" }, after: { projects: `select name, description from projects where uuid = '${P_BETA}'` } });
add({ name: "projects: update the description only", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}`, body: { description: "Changed" } });
add({ name: "projects: update, invalid", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}`, body: { name: "ab", team_id: 2 } });
add({ name: "projects: update another team's", token: "write", method: "PATCH", path: `/api/v1/projects/${P_OTHER}`, body: { name: "Mine" } });
add({ name: "projects: delete with resources (environments)", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_BETA}`, after: { projects: `select count(*) as n from projects where uuid = '${P_BETA}'` } });
add({ name: "projects: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/projects/nonexistentuuid" });
add({ name: "environments: create", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "preview" }, after: { environments: `select name, description from environments where project_id = 1 order by id` } });
add({ name: "environments: create, mixed case", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "  Preview Env  " }, after: { environments: `select name from environments where project_id = 1 order by id` } });
add({ name: "environments: create, extra field", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "preview", uuid: "x" } });
add({ name: "environments: create, existing name", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "staging" } });
add({ name: "environments: create, invalid", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "!", description: "x" } });
add({ name: "environments: create in an unknown project", token: "write", method: "POST", path: "/api/v1/projects/nonexistentuuid/environments", body: { name: "preview" } });
add({ name: "environments: update by name", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, body: { name: "qa-env", description: "Renamed" } });
add({ name: "environments: update by uuid", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/${E_STAGING}`, body: { description: "Only the description" } });
add({ name: "environments: update to an existing name", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, body: { name: "production" } });
add({ name: "environments: update unknown", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/nope`, body: { name: "qa-env" } });
add({ name: "environments: delete", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, after: { environments: "select name from environments where project_id = 1 order by id" } });
add({ name: "environments: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_ALPHA}/environments/nope` });

// ── private keys ────────────────────────────────────────────────────────────
add({ name: "keys: list", token: "read", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: show", token: "read", method: "GET", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: show, root", token: "root", method: "GET", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: show another team's", token: "read", method: "GET", path: `/api/v1/security/keys/${K_OTHER}` });

add({ name: "keys: create", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/rsa2048.pkcs1.pem" }, body: { name: "API key", description: "From the API" } });
add({ name: "keys: create base64", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ecdsa384.openssh" }, base64: ["private_key"], body: {} });
add({ name: "keys: create, no name or description", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ed25519.pkcs8.pem" }, body: {} });
add({ name: "keys: create, existing key", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ed25519.openssh" }, body: { name: "Again" } });
add({ name: "keys: create, not a key", token: "write", method: "POST", path: "/api/v1/security/keys", body: { name: "Bad key", private_key: "not a key" } });
add({ name: "keys: create, encrypted key", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/encrypted.openssh" }, body: { name: "Encrypted" } });
add({ name: "keys: create, invalid", token: "write", method: "POST", path: "/api/v1/security/keys", body: { name: "a", description: "<x>", extra: true } });
add({ name: "keys: update", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { name: "Renamed Key", description: "Now described" } });
add({ name: "keys: update, invalid", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { name: "", fingerprint: "x" } });
add({ name: "keys: update, replace the key", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, bodyFile: { private_key: "../ssh-keys/ecdsa521.openssh" }, body: {} });
add({ name: "keys: update, not a key", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { private_key: "garbage" } });
add({ name: "keys: update another team's", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_OTHER}`, body: { name: "Mine now" } });
add({ name: "keys: delete", token: "delete", method: "DELETE", path: `/api/v1/security/keys/${K_FREE}`, after: { keys: "select uuid from private_keys where team_id = 1 order by id" } });
add({ name: "keys: delete, in use", token: "delete", method: "DELETE", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/security/keys/nonexistentuuid" });

// ── servers ─────────────────────────────────────────────────────────────────
add({ name: "servers: list", token: "read", method: "GET", path: "/api/v1/servers" });
add({ name: "servers: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/servers" });
add({ name: "servers: show", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}` });
add({ name: "servers: show with resources", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}?resources=1` });
add({ name: "servers: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/servers/${S_MAIN}` });
add({ name: "servers: show unknown", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid" });
add({ name: "servers: resources", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/resources` });
add({ name: "servers: domains", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains` });
add({ name: "servers: validate", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate` });
add({ name: "servers: validate and install without deploy", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate`, body: { install: true } });
add({ name: "servers: validate, install not a boolean", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate`, body: { install: "maybe" } });
add({ name: "servers: validate unknown", token: "write", method: "POST", path: "/api/v1/servers/nonexistentuuid/validate" });
add({ name: "servers: validate with a read token", token: "read", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate` });

// ── applications (DP-71) ────────────────────────────────────────────────────
const APP_ENVS_AFTER = { variables: "select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, comment, \"order\", version from environment_variables where resourceable_id = 1 order by id" };
add({ name: "applications: list", token: "read", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list, root", token: "root", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list by an unknown tag", token: "read", method: "GET", path: "/api/v1/applications?tag=nope" });
add({ name: "applications: show", token: "read", method: "GET", path: `/api/v1/applications/${A_IMAGE}` });
add({ name: "applications: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}` });
add({ name: "applications: show a git application", token: "read", method: "GET", path: `/api/v1/applications/${A_GIT}` });
add({ name: "applications: show another team's", token: "read", method: "GET", path: `/api/v1/applications/${A_OTHER}` });
add({ name: "applications: show unknown", token: "read", method: "GET", path: "/api/v1/applications/nonexistentuuid" });
add({ name: "applications: logs", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/logs` });
add({ name: "applications: logs of unknown", token: "sensitive", method: "GET", path: "/api/v1/applications/nonexistentuuid/logs" });
add({ name: "applications: start", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/start` });
add({ name: "applications: start unknown", token: "root", method: "POST", path: "/api/v1/applications/nonexistentuuid/start" });
add({ name: "applications: start with GET", token: "root", method: "GET", path: `/api/v1/applications/${A_IMAGE}/start` });
add({ name: "applications: restart", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/restart` });
add({ name: "applications: stop", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/stop` });
add({ name: "applications: stop unknown", token: "root", method: "POST", path: "/api/v1/applications/nonexistentuuid/stop" });
add({ name: "applications: delete", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_GIT}`, after: { applications: "select uuid, deleted_at is not null as deleted from applications where environment_id in (1, 2) order by id" } });
add({ name: "applications: delete with options", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}?delete_volumes=false&docker_cleanup=0` });
add({ name: "applications: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/applications/nonexistentuuid" });
add({ name: "applications: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_OTHER}` });

add({ name: "application envs: list", token: "read", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list of a git application", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_GIT}/envs` });
add({ name: "application envs: list of unknown", token: "read", method: "GET", path: "/api/v1/applications/nonexistentuuid/envs" });
add({ name: "application envs: list another team's", token: "read", method: "GET", path: `/api/v1/applications/${A_OTHER}/envs` });
add({ name: "application envs: create", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "NEW_KEY", value: "new value" }, after: APP_ENVS_AFTER });
add({ name: "application envs: create with every field", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: " spaced key ", value: "  kept  ", is_preview: false, is_literal: true, is_multiline: true, is_shown_once: true, is_runtime: false, is_buildtime: false, comment: "A comment" }, after: APP_ENVS_AFTER });
add({ name: "application envs: create a preview variable", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "PREVIEW_ONLY", value: "p", is_preview: true }, after: APP_ENVS_AFTER });
add({ name: "application envs: create an existing key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "again" } });
add({ name: "application envs: create an existing preview key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "again", is_preview: true } });
add({ name: "application envs: create, invalid", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "1BAD-KEY", value: 5, is_literal: "maybe", comment: "x".repeat(257), extra: 1 } });
add({ name: "application envs: create, no key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { value: "v" } });
add({ name: "application envs: create, key with a dollar", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "A$B", value: "v" } });
add({ name: "application envs: create, not JSON", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, raw: "key=A", contentType: "application/x-www-form-urlencoded" });
add({ name: "application envs: create in unknown", token: "write", method: "POST", path: "/api/v1/applications/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "application envs: update", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "changed", is_literal: true, comment: "Changed" }, after: APP_ENVS_AFTER });
add({ name: "application envs: update, read:sensitive answer", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "changed" } });
add({ name: "application envs: update a locked variable", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "SECRET_TOKEN", value: "new secret", is_shown_once: false } });
add({ name: "application envs: update the preview copy", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "preview value", is_preview: true }, after: APP_ENVS_AFTER });
add({ name: "application envs: update unknown key", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "NOPE", value: "x" } });
add({ name: "application envs: update, invalid", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { value: ["x"], is_runtime: 2, uuid: "x" } });
add({ name: "application envs: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, raw: "{}" });
add({ name: "application envs: bulk", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "FOO", value: "bulk foo" }, { key: "BULK_NEW", value: "new", is_literal: true, ignored: "x" }, { key: "BULK_PREVIEW", value: "p", is_preview: true }] }, after: APP_ENVS_AFTER });
add({ name: "application envs: bulk, root answer", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "FOO", is_buildtime: false }, { key: "BULK_TWO", value: null }] } });
add({ name: "application envs: bulk, no data", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { items: [] } });
add({ name: "application envs: bulk, invalid item", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "GOOD", value: "1" }, { key: "", value: "x" }] }, after: APP_ENVS_AFTER });
add({ name: "application envs: bulk in unknown", token: "write", method: "PATCH", path: "/api/v1/applications/nonexistentuuid/envs/bulk", body: { data: [{ key: "A" }] } });
add({ name: "application envs: delete", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/${V_FOO}`, after: APP_ENVS_AFTER });
add({ name: "application envs: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/nonexistentuuid` });
add({ name: "application envs: delete another application's", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/${V_OTHER}` });
add({ name: "application envs: delete in unknown", token: "delete", method: "DELETE", path: `/api/v1/applications/nonexistentuuid/envs/${V_FOO}` });

/** The tables whose column order emit.php writes into the goldens (`columns`): what a nested relation serializes in. */
const columnsOf = ["servers", "server_settings", "standalone_dockers", "application_settings", "applications", "environment_variables", "application_deployment_queues"];

console.log(JSON.stringify({ fixture, columnsOf, cases }, null, 1));
