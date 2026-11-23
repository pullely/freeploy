// The TypeScript ports the command goldens are checked against, keyed by the
// Coolify helper name. Each milestone that ports a helper registers it here
// (DP4: docker/proxy/remoteProcess helpers, DP5: applications, …); a case whose
// helper is not registered is reported `pending`, never as a pass.
import { __ } from "../../../apps/identity-worker/src/laravel-messages.ts";
import { normalize_email_identity } from "../../../apps/identity-worker/src/email-identity.ts";

export type Port = (...args: never[]) => unknown;
export const PORTS: Record<string, Port> = {
  // Laravel's translator, for the auth and validation messages Coolify shows (DP3).
  __: __ as Port,
  // bootstrap/helpers/email.php (DP3).
  normalize_email_identity: normalize_email_identity as Port,
};
