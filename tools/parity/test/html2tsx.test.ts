import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatches, convert, swapBrand } from "../port/html2tsx.ts";

test("keeps DOM, classes and copy; drops Livewire/Alpine; swaps the brand", () => {
  const html = `<html><body><main class="flex"><h1 class="text-xl">Welcome to Coolify</h1>
    <form wire:submit="save" x-data="{a:1}" @click="b"><label for="e">Email</label>
    <input id="e" name="email" type="email" value="x" required>
    <img src="/coolify-logo.svg" alt="Coolify"><br></form><script>alert(1)</script></main></body></html>`;
  const out = convert(html, "main", "P", "test");
  assert.match(out, /<main className="flex">/);
  assert.match(out, /Welcome to Freeploy/);
  assert.match(out, /<label htmlFor="e">Email<\/label>/);
  assert.match(out, /<input id="e" name="email" type="email" defaultValue="x" required \/>/);
  assert.match(out, /alt="Freeploy"/);
  assert.doesNotMatch(out, /wire:|x-data|@click|<script/);
});

test("swapBrand replaces Coolify and Coolify Cloud", () => {
  assert.equal(swapBrand("Coolify Cloud and Coolify"), "Freeploy and Freeploy");
});

test("keeps the whitespace the browser renders between inline elements", () => {
  const out = convert(`<p id="x">Visit
    <a href="/n">notifications</a>
    to start.</p>`, "p", "P", "test");
  assert.match(out, /Visit\{" "\}/);
  assert.match(out, /\{" "\}to start\./);
});

test("writes quoted attribute values and custom/vendor style properties as valid JSX", () => {
  const out = convert(`<div id="d" data-options='[{"v":"s3"}]' style="--w: 3px; -webkit-mask: url(x)"></div>`, "div", "P", "test");
  assert.match(out, /data-options=\{"\[\{\\"v\\":\\"s3\\"\}\]"\}/);
  assert.match(out, /"--w": "3px"/);
  assert.match(out, /"WebkitMask": "url\(x\)"/);
  assert.match(out, /as Record<string, string>/);
});

test("--inner renders the first n children with a trailing prop; '!' slots replace children", () => {
  const out = convert(`<html><body><div class="a"></div><main class="m"><p>fixture</p></main><div class="page-overlay"></div></body></html>`, "body", "L", "test", {
    inner: true,
    take: 2,
    after: "portal",
    slots: ["main=!children"],
  });
  assert.match(out, /<>/);
  assert.match(out, /<main className="m">\{props\.children\}<\/main>/);
  assert.doesNotMatch(out, /fixture|page-overlay/);
  assert.match(out, /\{props\.portal\}/);
});

test("patches bind fixture values to props and fail when they no longer match", () => {
  const src = `<span>{" "}Root Team{" "}</span>`;
  const out = applyPatches(src, [{ find: '>(\\{" "\\})?Root Team(\\{" "\\})?<', replace: ">$1{props.teamName}$2<" }]);
  assert.equal(out, `<span>{" "}{props.teamName}{" "}</span>`);
  assert.throws(() => applyPatches(src, [{ find: "Other Team", replace: "x" }]), /did not match/);
});

test("the layout is the body prefix every page shares", async () => {
  const { sharedPrefix } = await import("../port/layout-take.ts");
  assert.equal(sharedPrefix(["div.a#", "div.b#", "div.page#"], ["div.a#", "div.b#", "div.other#"]), 2);
  assert.equal(sharedPrefix(["div.a#"], []), 0);
});

test("a Livewire-bound control keeps its binding as data-wire-model", () => {
  const out = convert(`<input id="host-abc" wire:model.live="endpointParts.host" type="text">`, "input", "P", "test");
  assert.match(out, /data-wire-model="endpointParts\.host"/);
  assert.doesNotMatch(out, /wire:/);
});
