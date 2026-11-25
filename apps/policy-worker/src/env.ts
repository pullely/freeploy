export interface Env {
  ENVIRONMENT: string;
  /**
   * The platform operators (freeploy-coolify-parity DP12): Freeploy user ids (`usr_…`), separated by commas
   * or white space, who may use Coolify's instance-level pages (/settings/*, /admin, Team → Admin View).
   * A runtime secret (`orun secrets set`), never in the repository; unset means nobody is an operator.
   */
  PLATFORM_OPERATORS?: string;
}
