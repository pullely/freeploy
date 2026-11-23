import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, swapBrand } from "../port/html2tsx.ts";

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
