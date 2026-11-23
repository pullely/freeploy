// The TypeScript ports the command goldens are checked against, keyed by the
// Coolify helper name. Each milestone that ports a helper registers it here
// (DP4: docker/proxy/remoteProcess helpers, DP5: applications, …); a case whose
// helper is not registered is reported `pending`, never as a pass.
export type Port = (...args: never[]) => unknown;
export const PORTS: Record<string, Port> = {};
