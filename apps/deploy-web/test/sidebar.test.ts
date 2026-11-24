import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSubmenu, childActive, requestIs, sidebarMenu, SUBMENUS, type NavSwap } from "../src/layout/sidebar.ts";

const PANELS = ["", ...SUBMENUS.map((s) => s.label)];

/** The panels a freshly loaded page shows ('' = the main menu), as the layout starts its sidebar. */
function visible(path: string): string[] {
  const active = activeSubmenu(path);
  const menu = sidebarMenu({ submenu: active, navSwap: "" }, active, () => {});
  return PANELS.filter((label) => !menu.panel(label).style);
}

test("Laravel's request()->is: slashes trimmed, * matches anything", () => {
  assert.equal(requestIs("/", ["/"]), true);
  assert.equal(requestIs("/security/private-key/", ["security/private-key*"]), true);
  assert.equal(requestIs("/security/private-key/abc", ["security/private-key*"]), true);
  assert.equal(requestIs("/team/members", ["team"]), false);
  assert.equal(requestIs("/teams", ["team"]), false);
});

test("the sidebar starts on the submenu that holds the current page", () => {
  assert.deepEqual(visible("/security/private-key"), ["Keys & Tokens"]);
  assert.deepEqual(visible("/security/private-key/abc123def456ghi789jkl012"), ["Keys & Tokens"]);
  assert.deepEqual(visible("/security/api-tokens"), ["Keys & Tokens"]);
  assert.deepEqual(visible("/team"), ["Team"]);
  assert.deepEqual(visible("/team/members"), ["Team"]);
  assert.deepEqual(visible("/notifications/email"), ["Notifications"]);
  assert.deepEqual(visible("/profile"), [""]);
  assert.deepEqual(visible("/servers"), [""]);
  assert.deepEqual(visible("/"), [""]);
});

test("the current page's submenu is marked, and so is its parent entry", () => {
  const menu = sidebarMenu({ submenu: "Keys & Tokens", navSwap: "" }, "Keys & Tokens", () => {});
  assert.deepEqual(menu.panel("Keys & Tokens"), { "data-active-submenu": "Keys & Tokens" });
  assert.deepEqual(menu.panel("Team"), { style: { display: "none" } });
  assert.deepEqual(menu.panel(""), { style: { display: "none" } });
  assert.equal(menu.parent("Keys & Tokens").className, "menu-item w-full menu-item-active");
  assert.equal(menu.parent("Team").className, "menu-item w-full");
  assert.equal(menu.list, "flex flex-col gap-y-0.5");
  assert.equal(childActive("/security/private-key/abc", "/security/private-key"), true);
  assert.equal(childActive("/security/private-key", "/security/api-tokens"), false);
});

test("a parent entry opens its submenu forward; Back opens the main menu", () => {
  let state: { submenu: string; navSwap: NavSwap } = { submenu: "", navSwap: "" };
  const set = (s: typeof state) => (state = s);
  sidebarMenu(state, "", set).parent("Keys & Tokens").onClick();
  assert.deepEqual(state, { submenu: "Keys & Tokens", navSwap: "forward" });
  let menu = sidebarMenu(state, "", set);
  assert.equal(menu.list, "flex flex-col gap-y-0.5 nav-swap-forward");
  assert.deepEqual(menu.panel("Keys & Tokens"), {});
  assert.deepEqual(menu.panel(""), { style: { display: "none" } });
  menu.back();
  menu = sidebarMenu(state, "", set);
  assert.equal(menu.list, "flex flex-col gap-y-0.5 nav-swap-back");
  assert.deepEqual(menu.panel(""), {});
});
