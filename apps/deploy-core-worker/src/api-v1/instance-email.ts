// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/InstanceEmailSettingsController.php (show, update,
// authorizeRootTeam, serialize), app/Policies/InstanceSettingsPolicy.php, app/Models/InstanceSettings.php ($hidden, $casts)
// and bootstrap/helpers/api.php (exposeSensitiveFields) (Apache-2.0), modified.
//
// Coolify's GET and PATCH /api/v1/settings/email (DP-106): the instance's SMTP and Resend settings, which in a hosted
// Freeploy are the platform operator's — row 0 of deploy.instance_settings, DP-101's Email settings page, read and written
// in asPlatformAdmin() with the encrypted columns as fp1 ciphertexts under the platform row's data key (DP-101's store).
//
// Coolify asks two things: a root-team token (the token's team is team 0, else abort(403, "Instance email settings require
// a root-team API token.")), then InstanceSettingsPolicy (isInstanceAdmin(): an admin or owner of team 0). Freeploy has no
// root team; its instance admin is the platform operator (DP-79's gate: policy-worker's platform.settings.read for a read,
// platform.settings.update for a change, which only the deployment's PLATFORM_OPERATORS pass). So the token's user is asked
// of policy-worker as the platform operator, whichever org the token is of, and a user who is not one is answered with the
// root-team refusal — what Coolify answers every token that is not its instance admin's, a root-team member's aside (that
// member's "This action is unauthorized." has no counterpart: Freeploy has no root-team members who are not operators).
// The sensitive columns ($hidden) are answered, decrypted, only to a token that may read sensitive data (root or
// read:sensitive of an owner or admin: api-edge's canReadSensitive), as exposeSensitiveFields() does.
//
// Not ported: the audit log line (`api.settings.email.updated`).
import type { PlatformMoreRunner } from "../handlers/platform-settings-more.js";
import type { SettingsRow } from "../notifications/settings.js";
import { coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import type { ApiV1Context } from "./context.js";
import { email, validHostname } from "./notifications.js";
import { readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";

export const INSTANCE_EMAIL_MESSAGES = {
  /** authorizeRootTeam(): abort_unless(…, 403, …) */
  rootTeamOnly: "Instance email settings require a root-team API token.",
} as const;

/** The platform's stores (DP-101) and whether the token's user is the platform operator. */
export interface InstanceEmailAccess {
  operator(action: "platform.settings.read" | "platform.settings.update"): Promise<boolean>;
  platform: PlatformMoreRunner;
}

/** FIELDS, in the order of instance_settings' columns (Arr::only() of toArray() keeps the attributes' order). */
const FIELDS = [
  "smtp_enabled",
  "smtp_from_address",
  "smtp_from_name",
  "smtp_host",
  "smtp_port",
  "smtp_encryption",
  "smtp_username",
  "smtp_password",
  "smtp_timeout",
  "resend_enabled",
  "resend_api_key",
  "smtp_ehlo_domain",
  "notification_from_address",
  "notification_from_name",
  "resend_from_address",
  "resend_from_name",
] as const;

/** InstanceSettings::$hidden (of FIELDS). */
const HIDDEN: readonly string[] = ["smtp_from_address", "smtp_from_name", "notification_from_address", "notification_from_name", "smtp_host", "smtp_username", "smtp_password", "resend_api_key", "resend_from_address", "resend_from_name"];
const BOOLEANS: readonly string[] = ["smtp_enabled", "resend_enabled"];
const INTEGERS: readonly string[] = ["smtp_port", "smtp_timeout"];

/** abort(403, …) as the exception handler renders an HttpException under api/* (JSON_PRETTY_PRINT). */
const aborted = (text: string): CoolifyAnswer => ({ status: 403, body: `{\n    "message": ${JSON.stringify(text).replace(/\//g, "\\/")}\n}`, headers: { "content-type": "application/json" } });

/** A column as InstanceSettings' casts give it. */
function cast(column: string, v: unknown): PhpValue {
  if (v === null || v === undefined) return null;
  if (BOOLEANS.includes(column)) return v === true || v === 1 || v === "1" || v === "t" || v === "true";
  if (INTEGERS.includes(column)) return Math.trunc(Number(v));
  return String(v);
}

/** serialize(): exposeSensitiveFields(), then Arr::only($settings->toArray(), FIELDS). */
function serialize(row: SettingsRow, canReadSensitive: boolean): CoolifyAnswer {
  const entries: Array<[string, PhpValue]> = [];
  for (const f of FIELDS) if (canReadSensitive || !HIDDEN.includes(f)) entries.push([f, cast(f, row[f])]);
  return coolifyJson(obj(entries));
}

/** update()'s rules, in the controller's order: every one `sometimes` (an absent field is neither checked nor written). */
const RULES: Rules = [
  ["smtp_enabled", ["sometimes", "boolean"]],
  ["smtp_from_address", ["sometimes", "nullable", email("smtp_from_address")]],
  ["smtp_from_name", ["sometimes", "nullable", "string", "max:255"]],
  ["notification_from_address", ["sometimes", "nullable", email("notification_from_address")]],
  ["notification_from_name", ["sometimes", "nullable", "string", "max:255"]],
  ["smtp_host", ["sometimes", "nullable", "string", "max:255"]],
  ["smtp_port", ["sometimes", "nullable", "integer", "min:1", "max:65535"]],
  ["smtp_encryption", ["sometimes", "nullable", "string", { in: ["starttls", "tls", "none"] }]],
  ["smtp_username", ["sometimes", "nullable", "string", "max:255"]],
  ["smtp_password", ["sometimes", "nullable", "string", "max:255"]],
  ["smtp_timeout", ["sometimes", "nullable", "integer", "min:0"]],
  ["smtp_ehlo_domain", ["sometimes", "nullable", "string", "max:255", validHostname("smtp_ehlo_domain")]],
  ["resend_enabled", ["sometimes", "boolean"]],
  ["resend_api_key", ["sometimes", "nullable", "string", "max:255"]],
  ["resend_from_address", ["sometimes", "nullable", email("resend_from_address")]],
  ["resend_from_name", ["sometimes", "nullable", "string", "max:255"]],
];

/** authorizeRootTeam(): the root-team refusal unless the token's user is the platform operator (see the header). */
async function rootTeamRefusal(access: InstanceEmailAccess, write: boolean): Promise<CoolifyAnswer | null> {
  return (await access.operator(write ? "platform.settings.update" : "platform.settings.read")) ? null : aborted(INSTANCE_EMAIL_MESSAGES.rootTeamOnly);
}

/** routes/api.php's /settings/email; null for every other method (the fallback 404). */
export async function instanceEmailApi(c: ApiV1Context, access: InstanceEmailAccess): Promise<CoolifyAnswer | null> {
  if (c.method === "GET") {
    const no = await rootTeamRefusal(access, false);
    if (no) return no;
    return serialize(await access.platform(c.env, (s) => s.email.load()), c.canReadSensitive);
  }
  if (c.method !== "PATCH") return null;
  const no = await rootTeamRefusal(access, true);
  if (no) return no;
  // $request->json()->all(): nothing of a body that is not JSON.
  const read = await readApiBody(c.request);
  const body = read.isJson ? read.all : {};
  const errors: Errors = [];
  await validateRules(errors, body, RULES);
  if (errors.length) return validationFailed(errors);
  // fill($validator->validated()), save(), refresh(): the casts applied as the columns are written.
  const changes: SettingsRow = {};
  for (const [field] of RULES) {
    if (!Object.hasOwn(body, field)) continue;
    const v = body[field];
    changes[field] = BOOLEANS.includes(field) ? cast(field, v) : INTEGERS.includes(field) && v !== null ? Math.trunc(Number(v)) : (v as PhpValue);
  }
  const saved = await access.platform(c.env, (s) => (Object.keys(changes).length ? s.email.save(changes) : s.email.load()));
  return serialize(saved, c.canReadSensitive);
}
