// Every auth route that carries a body gets it at identity: PUT (the avatar
// image) and DELETE (the password confirming a passkey or account deletion).
import { handleAuthRoute } from "@api-edge/auth-facade";

function fake() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
      return Promise.resolve(Response.json({ data: {} }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const read = async (b: BodyInit | null | undefined) => (b ? await new Response(b).text() : "");

describe("auth facade request bodies", () => {
  it("forwards a DELETE body (the password)", async () => {
    const { fetcher, calls } = fake();
    const path = "/v1/auth/passkeys/00000000-0000-4000-8000-000000000001";
    await handleAuthRoute(new Request(`https://api.example.com${path}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) }), { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" }, "req_1", path);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(await read(calls[0]!.init.body)).toBe('{"password":"x"}');
  });

  it("forwards a PUT body (the avatar)", async () => {
    const { fetcher, calls } = fake();
    await handleAuthRoute(new Request("https://api.example.com/v1/auth/avatar", { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff]) }), { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" }, "req_2", "/v1/auth/avatar");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((await new Response(calls[0]!.init.body ?? null).arrayBuffer()).byteLength).toBe(3);
  });
});
