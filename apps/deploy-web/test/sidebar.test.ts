import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSubmenu, childActive, mainMenuActive, requestIs, sidebarMenu, SUBMENUS, type NavSwap } from "../src/layout/sidebar.ts";

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
  assert.deepEqual(visible("/destinations"), ["Integrations"]);
  assert.deepEqual(visible("/destination/abc123def456ghi789jkl012/danger"), ["Integrations"]);
  assert.equal(childActive("/destination/abc123def456ghi789jkl012/resources", "/destinations"), true);
  // A server's destinations are a server page: the main menu, Servers current.
  assert.deepEqual(visible("/server/abc123def456ghi789jkl012/destinations"), [""]);
  // Registries is under Integrations; a server's registries are a server page.
  assert.deepEqual(visible("/registries"), ["Integrations"]);
  assert.equal(childActive("/registries", "/registries"), true);
  assert.equal(childActive("/registries", "/destinations"), false);
  assert.deepEqual(visible("/server/abc123def456ghi789jkl012/registries"), [""]);
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
  assert.equal(childActive("/security/cloud-tokens/abc", "/security/cloud-tokens"), true);
  assert.equal(childActive("/security/cloud-init-scripts/abc", "/security/cloud-init-scripts"), true);
  assert.equal(childActive("/security/cloud-init-scripts", "/security/cloud-tokens"), false);
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

test("Projects is the current main menu entry on every project and environment page", () => {
  for (const path of ["/projects", "/projects/", "/projects/canvas", "/project/abc", "/project/abc/edit", "/project/abc/environment/def", "/project/abc/environment/def/edit", "/project/abc/environment/def/new"]) {
    assert.equal(mainMenuActive(path, "/projects"), true, path);
    assert.equal(activeSubmenu(path), "", path);
  }
  for (const path of ["/", "/servers", "/shared-variables/projects", "/shared-variables/project/abc", "/project", "/projectsx"]) assert.equal(mainMenuActive(path, "/projects"), false, path);
  assert.equal(mainMenuActive("/projects", "/servers"), false);
});

test("every shared variables page opens the Shared Variables submenu on its own entry", () => {
  const project = "abc123def456ghi789jkl012";
  const current = (path: string) => SUBMENUS.find((s) => s.label === "Shared Variables")!.children.filter((c) => childActive(path, c.href)).map((c) => c.href);
  for (const [path, href] of [
    ["/shared-variables", "/shared-variables"],
    ["/shared-variables/team", "/shared-variables/team"],
    ["/shared-variables/team/canvas", "/shared-variables/team"],
    ["/shared-variables/projects", "/shared-variables/projects"],
    [`/shared-variables/project/${project}`, "/shared-variables/projects"],
    ["/shared-variables/environments", "/shared-variables/environments"],
    [`/shared-variables/environments/project/${project}/environment/mno345pqr678stu901vwx234`, "/shared-variables/environments"],
    ["/shared-variables/servers", "/shared-variables/servers"],
    [`/shared-variables/server/${project}`, "/shared-variables/servers"],
  ] as const) {
    assert.deepEqual(visible(path), ["Shared Variables"]);
    assert.deepEqual(current(path), [href]);
  }
  // A project's own pages stay under Projects in the main menu.
  assert.deepEqual(visible(`/project/${project}`), [""]);
});
