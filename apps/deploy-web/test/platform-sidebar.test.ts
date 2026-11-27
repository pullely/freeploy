// The sidebar's platform entries (DP-79): Coolify shows its instance admin a Settings submenu and Team → Admin
// View; in Freeploy only a platform operator has them. Anyone else's sidebar is the reference's: on a settings
// path it stays on the main menu, as there is no Settings panel to open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSubmenu, childActive, OPERATOR_SUBMENUS, sidebarMenu, submenusFor, SUBMENUS } from "../src/layout/sidebar.ts";

function visible(path: string, operator: boolean): string[] {
  const active = activeSubmenu(path, operator);
  const menu = sidebarMenu({ submenu: active, navSwap: "" }, active, () => {});
  return ["", ...submenusFor(operator).map((s) => s.label)].filter((label) => !menu.panel(label).style);
}

test("a non-operator's sidebar has no Settings submenu and no Admin View", () => {
  assert.deepEqual(submenusFor(false), SUBMENUS);
  for (const path of ["/settings", "/settings/advanced", "/settings/updates", "/settings/image-scanning", "/settings/oauth/github", "/settings/email", "/settings/backup", "/team/admin", "/admin"]) {
    assert.equal(activeSubmenu(path), "", path);
    assert.deepEqual(visible(path, false), [""], path);
  }
  assert.equal(childActive("/team/admin", "/team/admin"), false);
});

test("an operator's: Settings (General, Advanced, and since DP-101 Updates, Authentication, Email, Backup, since DP-116 Image Scanning) last, and Admin View after Image Scanning in Team", () => {
  const menus = submenusFor(true);
  assert.deepEqual(
    menus.map((s) => s.label),
    [...SUBMENUS.map((s) => s.label), "Settings"],
  );
  assert.deepEqual(OPERATOR_SUBMENUS[0]!.children.map((c) => c.href), ["/settings", "/settings/advanced", "/settings/updates", "/settings/image-scanning", "/settings/oauth", "/settings/email", "/settings/backup"]);
  assert.deepEqual(
    menus.find((s) => s.label === "Team")!.children.map((c) => c.href),
    ["/team", "/team/members", "/team/audit-log", "/team/image-scanning", "/team/admin", "/team/danger"],
  );
  assert.deepEqual(visible("/settings", true), ["Settings"]);
  assert.deepEqual(visible("/settings/advanced/", true), ["Settings"]);
  assert.deepEqual(visible("/team/admin", true), ["Team"]);
  assert.deepEqual(visible("/admin", true), [""]);
  assert.equal(childActive("/settings", "/settings", true), true);
  assert.equal(childActive("/settings/advanced", "/settings", true), false);
  assert.deepEqual(visible("/settings/oauth/github", true), ["Settings"]);
  assert.equal(childActive("/settings/oauth/github", "/settings/oauth", true), true);
  assert.equal(childActive("/settings/email", "/settings/oauth", true), false);
  assert.equal(childActive("/team/admin", "/team/admin", true), true);
});
