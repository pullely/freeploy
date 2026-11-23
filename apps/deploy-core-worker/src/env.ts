export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** Platform KEK (base64, 32 bytes) wrapping each org's data key. A Worker secret. */
  DEPLOY_ENCRYPTION_KEY?: string;
  ENVIRONMENT: string;
}
