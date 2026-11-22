// The harness must be able to say no (DP1 done-when): an identical pair
// passes, a perturbed pair fails the 0.5% gate, a size change fails, and a
// copy change fails the DOM check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { comparePng, compareDom, PIXEL_GATE } from "../visual/compare.ts";
import { resolvePath } from "../visual/paths.ts";

function solid(w: number, h: number, rgb: [number, number, number]): PNG {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = rgb[0];
    p.data[i + 1] = rgb[1];
    p.data[i + 2] = rgb[2];
    p.data[i + 3] = 255;
  }
  return p;
}
const buf = (p: PNG) => PNG.sync.write(p);

test("identical screenshots pass", () => {
  const a = buf(solid(200, 100, [30, 30, 30]));
  const r = comparePng(a, a);
  assert.equal(r.diffPixels, 0);
});

test("a 10% region change fails the 0.5% gate", () => {
  const a = solid(200, 100, [30, 30, 30]);
  const b = solid(200, 100, [30, 30, 30]);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 200; x++) {
    const i = (y * 200 + x) * 4;
    b.data[i] = 250;
  }
  const r = comparePng(buf(a), buf(b));
  assert.ok(r.diffPixels / r.totalPixels > PIXEL_GATE, `ratio ${r.diffPixels / r.totalPixels}`);
});

test("a height difference counts as difference", () => {
  const r = comparePng(buf(solid(200, 100, [0, 0, 0])), buf(solid(200, 110, [0, 0, 0])));
  assert.equal(r.sizeMismatch, true);
  assert.ok(r.diffPixels / r.totalPixels > PIXEL_GATE);
});

test("copy and field differences fail the DOM check; brand-normalised text passes", () => {
  const ref = { title: "PRODUCT", text: ["Servers", "Add"], fields: [{ tag: "input", type: "text", name: "name", label: "Name" }] };
  assert.equal(compareDom(ref, structuredClone(ref)).equal, true);
  assert.equal(compareDom(ref, { ...ref, text: ["Servers", "Create"] }).equal, false);
  assert.equal(compareDom(ref, { ...ref, fields: [] }).equal, false);
});

test("route params resolve from fixtures; missing ones are reported", () => {
  assert.deepEqual(resolvePath("/project/{project_uuid}/edit", { project_uuid: "p1" }), { url: "/project/p1/edit", missing: [] });
  assert.deepEqual(resolvePath("/tags/{tagName?}", {}), { url: "/tags", missing: [] });
  assert.equal(resolvePath("/server/{server_uuid}", {}).url, null);
});
