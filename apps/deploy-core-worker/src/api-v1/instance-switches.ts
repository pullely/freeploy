// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/OtherController.php (post_required, disable_api,
// enable_mcp, disable_mcp), app/Policies/InstanceSettingsPolicy.php and app/Models/InstanceSettings.php (Apache-2.0),
// modified.
//
// Coolify's GET and POST /api/v1/disable and POST /api/v1/mcp/{enable,disable} (DP-107): the instance's API and MCP
// server switches. Coolify asks the token's team to be the root team (team 0) and its user to be the instance admin
// (InstanceSettingsPolicy::update(): isInstanceAdmin()), and answers every other token the controller's own 403. Freeploy
// has no root team; its instance admin is the platform operator (DP-106's gate: policy-worker's platform.settings.update),
// so the token's user is asked of policy-worker, whichever org the token is of, and is answered with that 403 unless they
// are the operator.
//
// The MCP switch is row 0's is_mcp_server_enabled (DP-101's platform row, written in asPlatformAdmin()): stored as Coolify
// stores it. Freeploy has no MCP server (no /mcp endpoint reads the switch), so turning it on serves nothing yet.
//
// Disabling the API is a departure: in Freeploy Coolify's is_api_enabled is api-edge's API_ENABLED, a deployment variable
// (DP-70) the API cannot change, so the operator is answered 501 in Coolify's envelope and nothing is stored, where Coolify
// stores false and answers "API disabled.".
//
// routes/api.php's group of these routes has neither ApiAllowed nor api.sensitive; api-edge runs api.ip.allowed for them.
// Not ported: the audit log lines (`api.instance.disable_denied`, `api.instance.disabled`, `api.mcp.*`).
import type { PlatformMoreRunner } from "../handlers/platform-settings-more.js";
import type { CoolifyAnswer } from "@saas/contracts/coolify-api";
import { message, unavailable, type ApiV1Context } from "./context.js";

export const INSTANCE_SWITCH_MESSAGES = {
  disableDenied: "You are not allowed to disable the API.",
  disabled: "API disabled.",
  enableMcpDenied: "You are not allowed to enable the MCP server.",
  mcpEnabled: "MCP server enabled.",
  disableMcpDenied: "You are not allowed to disable the MCP server.",
  mcpDisabled: "MCP server disabled.",
  /** Freeploy's: is_api_enabled is api-edge's API_ENABLED (DP-70), set where Freeploy is deployed. */
  disableUnavailable: "Disabling the API needs api-edge's API_ENABLED setting, which is set where Freeploy is deployed and not by the API.",
} as const;

/** Whether the token's user is the platform operator, and the platform's stores (DP-101, DP-106). */
export interface InstanceSwitchAccess {
  operator(action: "platform.settings.update"): Promise<boolean>;
  platform: PlatformMoreRunner;
}

/** OtherController's /disable, /mcp/enable and /mcp/disable; null for any other path or method (the fallback 404). */
export async function instanceSwitchesApi(c: ApiV1Context, segments: readonly string[], access: InstanceSwitchAccess): Promise<CoolifyAnswer | null> {
  const [first, second, third] = segments;
  if (first === "disable" && second === undefined) {
    // Route::get('/disable', post_required)
    if (c.method === "GET") return message("This endpoint has changed to a POST request.", 405);
    if (c.method !== "POST") return null;
    if (!(await access.operator("platform.settings.update"))) return message(INSTANCE_SWITCH_MESSAGES.disableDenied, 403);
    return unavailable(INSTANCE_SWITCH_MESSAGES.disableUnavailable);
  }
  if (first !== "mcp" || third !== undefined || c.method !== "POST" || (second !== "enable" && second !== "disable")) return null;
  const enable = second === "enable";
  if (!(await access.operator("platform.settings.update"))) return message(enable ? INSTANCE_SWITCH_MESSAGES.enableMcpDenied : INSTANCE_SWITCH_MESSAGES.disableMcpDenied, 403);
  // $settings->update(['is_mcp_server_enabled' => …])
  await access.platform(c.env, (s) => s.mcp.save({ is_mcp_server_enabled: enable }));
  return message(enable ? INSTANCE_SWITCH_MESSAGES.mcpEnabled : INSTANCE_SWITCH_MESSAGES.mcpDisabled, 200);
}
