// DP-63: what a write gets from Postgres when a unique index refuses it — the
// case of two requests that both asked "is this name free?" before either
// wrote. A memory store cannot race, so a test puts this in a store's write.
import type { DeployUniqueIndex } from "@saas/db/deploy";

/** postgres.js's PostgresError for SQLSTATE 23505, with the index it names. */
export function uniqueViolation(index: DeployUniqueIndex | string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${index}"`), { code: "23505", constraint_name: index });
}

/** A store write that the index refuses. */
export const refusedBy = (index: DeployUniqueIndex | string) => async (): Promise<never> => {
  throw uniqueViolation(index);
};

/** handleError()'s text for Laravel's UniqueConstraintViolationException. */
export const DUPLICATE_ENTRY = "Duplicate entry found. Please use a different name.";
