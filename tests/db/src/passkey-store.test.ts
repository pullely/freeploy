// The passkey store binds only scalars (the executor runs postgres.js with
// fetch_types off, which cannot serialise a JS array to text[]).
import { createPasskeyStore } from "@saas/db/identity";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

function recorder(rows: SqlRow[] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  const executor = {
    execute: async <T extends SqlRow>(text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows, rowCount: rows.length } as unknown as SqlExecutorResult<T>;
    },
    dispose: async () => {},
  } as unknown as SqlExecutor;
  return { executor, calls };
}

describe("passkey store", () => {
  it("sends transports as one comma-joined string, never an array", async () => {
    const { executor, calls } = recorder();
    await createPasskeyStore(executor).add({ id: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", name: "Chrome on Mac", credentialId: "cred", publicKey: "pk", counter: 0, transports: ["internal", "hybrid"] });
    expect(calls[0]!.text).toContain("string_to_array($7, ',')");
    expect(calls[0]!.params.every((p) => !Array.isArray(p))).toBe(true);
    expect(calls[0]!.params[6]).toBe("internal,hybrid");
  });

  it("reads transports back as a list", async () => {
    const { executor } = recorder([{ id: "i", user_id: "u", name: "n", credential_id: "c", public_key: "p", counter: "3", transports: "internal,hybrid", created_at: new Date(0), last_used_at: null }]);
    const [p] = await createPasskeyStore(executor).list("u");
    expect(p!.transports).toEqual(["internal", "hybrid"]);
    expect(p!.counter).toBe(3);
  });
});
