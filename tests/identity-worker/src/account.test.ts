// Account deletion and avatars (freeploy-coolify-parity DP3).
import { avatarErrors, imageSize } from "../../../apps/identity-worker/src/handlers/avatar";
import { handleAccountDelete, handleDeletionInfo, DELETION_ACTIONS } from "../../../apps/identity-worker/src/handlers/account";
import type { Env } from "../../../apps/identity-worker/src/env";

const png = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 0, 0, 0, 0]);

describe("avatar", () => {
  it("reads PNG and JPEG sizes", () => {
    expect(imageSize(png(300, 200))).toEqual({ w: 300, h: 200 });
    expect(imageSize(jpeg(256, 128))).toEqual({ w: 256, h: 128 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("applies Coolify's rules with Laravel's messages", () => {
    expect(avatarErrors("image/jpeg", new Uint8Array())).toEqual(["The avatar field is required."]);
    expect(avatarErrors("image/gif", png(10, 10))).toEqual(["The avatar field must be an image.", "The avatar field must be a file of type: jpg, jpeg, png, webp."]);
    expect(avatarErrors("image/png", png(7000, 10))).toEqual(["The avatar field has invalid image dimensions."]);
    expect(avatarErrors("image/jpeg", jpeg(256, 256))).toEqual([]);
  });
});

describe("account deletion", () => {
  it("needs a session", async () => {
    const env = { ENVIRONMENT: "test", PLATFORM_DB: {} } as unknown as Env;
    expect((await handleDeletionInfo(new Request("https://i/x"), env, "r")).status).toBe(401);
    expect((await handleAccountDelete(new Request("https://i/x", { method: "DELETE", body: "{}" }), env, "r")).status).toBe(401);
  });

  it("states what happens, branded", () => {
    expect(DELETION_ACTIONS).toEqual(["Your account will be permanently deleted from Freeploy."]);
  });
});
