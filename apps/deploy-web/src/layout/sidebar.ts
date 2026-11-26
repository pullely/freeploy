// Derived from coollabsio/coolify@91b7e3e:resources/views/components/navbar.blade.php (Apache-2.0), modified.
//
// The sidebar's submenus. An entry with children opens a submenu in place of
// the main menu; the sidebar starts on the submenu that holds the current page
// (a child whose `request()->is(...)` patterns match the path), else on the
// main menu. Each submenu's Back shows the main menu, and a parent entry opens
// its submenu, without leaving the page; `navSwap` ('forward' or 'back') picks
// the enter animation of every menu list.
//
// SUBMENUS lists the entries the reference renders (a non-admin's sidebar: no
// Settings submenu, no Team → Admin View). A platform operator (DP-79) also has
// Coolify's instance admin's entries, OPERATOR_SUBMENUS and Team → Admin View;
// every function takes whether the signed-in user is one.

export interface SubmenuChild {
  href: string;
  /** The child's `request()->is(...)` patterns. */
  is: string[];
}

export const SUBMENUS: ReadonlyArray<{ label: string; children: SubmenuChild[] }> = [
  {
    label: "Monitoring",
    children: [
      { href: "/analytics", is: ["analytics"] },
      { href: "/metrics", is: ["metrics"] },
      { href: "/vulnerabilities", is: ["vulnerabilities"] },
    ],
  },
  {
    label: "Integrations",
    children: [
      { href: "/sources", is: ["sources", "source/*"] },
      { href: "/destinations", is: ["destinations", "destination/*"] },
      { href: "/registries", is: ["registries"] },
      { href: "/storages", is: ["storages", "storages/*"] },
    ],
  },
  {
    label: "Shared Variables",
    children: [
      { href: "/shared-variables", is: ["shared-variables"] },
      { href: "/shared-variables/team", is: ["shared-variables/team*"] },
      { href: "/shared-variables/projects", is: ["shared-variables/projects", "shared-variables/project/*"] },
      { href: "/shared-variables/environments", is: ["shared-variables/environments*"] },
      { href: "/shared-variables/servers", is: ["shared-variables/servers", "shared-variables/server/*"] },
    ],
  },
  {
    label: "Team",
    children: [
      { href: "/team", is: ["team"] },
      { href: "/team/members", is: ["team/members*"] },
      { href: "/team/audit-log", is: ["team/audit-log"] },
      { href: "/team/image-scanning", is: ["team/image-scanning"] },
      { href: "/team/danger", is: ["team/danger"] },
    ],
  },
  {
    label: "Notifications",
    children: [
      { href: "/notifications/email", is: ["notifications/email"] },
      { href: "/notifications/discord", is: ["notifications/discord"] },
      { href: "/notifications/telegram", is: ["notifications/telegram"] },
      { href: "/notifications/slack", is: ["notifications/slack"] },
      { href: "/notifications/pushover", is: ["notifications/pushover"] },
      { href: "/notifications/webhook", is: ["notifications/webhook"] },
    ],
  },
  {
    label: "Keys & Tokens",
    children: [
      { href: "/security/private-key", is: ["security/private-key*"] },
      { href: "/security/api-tokens", is: ["security/api-tokens"] },
      { href: "/security/cloud-tokens", is: ["security/cloud-tokens*"] },
      { href: "/security/integration-tokens", is: ["security/integration-tokens"] },
      { href: "/security/cloud-init-scripts", is: ["security/cloud-init-scripts*"] },
    ],
  },
];

/**
 * Main menu entries that are current on more than their own path: the entry's
 * `'active' => request()->is(...)` patterns (Projects is current on every
 * project and environment page).
 */
export const MAIN_MENU: ReadonlyArray<SubmenuChild> = [{ href: "/projects", is: ["projects", "projects/*", "project/*"] }];

/** Laravel's Request::is: the decoded path without its slashes ('/' for the root), `*` matching anything. */
export function requestIs(pathname: string, patterns: string[]): boolean {
  let path = pathname.replace(/^\/+|\/+$/g, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed escapes: match the raw path */
  }
  if (path === "") path = "/";
  return patterns.some((p) => {
    if (p === path) return true;
    const quoted = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
    return new RegExp("^" + quoted + "$", "u").test(path);
  });
}

/**
 * The platform operator's submenu (DP-79): navbar.blade.php's Settings, `'visible' => $teamWide && isInstanceAdmin()`,
 * with the pages Freeploy has (General, Advanced, and since DP-101 Updates, Authentication, Email and Backup; Image
 * Scanning is not ported). Coolify lists it last, after Tags.
 */
export const OPERATOR_SUBMENUS: ReadonlyArray<{ label: string; children: SubmenuChild[] }> = [
  {
    label: "Settings",
    children: [
      { href: "/settings", is: ["settings"] },
      { href: "/settings/advanced", is: ["settings/advanced"] },
      { href: "/settings/updates", is: ["settings/updates"] },
      { href: "/settings/oauth", is: ["settings/oauth*"] },
      { href: "/settings/email", is: ["settings/email"] },
      { href: "/settings/backup", is: ["settings/backup"] },
    ],
  },
];

/** Team → Admin View, `'visible' => isInstanceAdmin()`: after Image Scanning. */
export const OPERATOR_TEAM_CHILD: SubmenuChild = { href: "/team/admin", is: ["team/admin"] };

/** The submenus a user's sidebar has: an operator's also hold the platform's pages. */
export function submenusFor(operator: boolean): ReadonlyArray<{ label: string; children: SubmenuChild[] }> {
  if (!operator) return SUBMENUS;
  const withAdminView = SUBMENUS.map((s) => {
    if (s.label !== "Team") return s;
    const at = s.children.findIndex((c) => c.href === "/team/image-scanning") + 1;
    return { ...s, children: [...s.children.slice(0, at), OPERATOR_TEAM_CHILD, ...s.children.slice(at)] };
  });
  return [...withAdminView, ...OPERATOR_SUBMENUS];
}

/** The submenu holding the current page ('' for the main menu). */
export function activeSubmenu(pathname: string, operator = false): string {
  return submenusFor(operator).find((s) => s.children.some((c) => requestIs(pathname, c.is)))?.label ?? "";
}

/** Whether a submenu child is the current page. */
export function childActive(pathname: string, href: string, operator = false): boolean {
  const child = submenusFor(operator)
    .flatMap((s) => s.children)
    .find((c) => c.href === href);
  return child ? requestIs(pathname, child.is) : false;
}

/** Whether a main menu entry with patterns of its own is the current one. */
export function mainMenuActive(pathname: string, href: string): boolean {
  const entry = MAIN_MENU.find((m) => m.href === href);
  return entry ? requestIs(pathname, entry.is) : false;
}

export type NavSwap = "" | "forward" | "back";

/** What the generated sidebar binds: one per sidebar copy (the desktop sidebar, the mobile drawer). */
export interface SidebarMenu {
  /** A menu panel (`''` = the main menu): hidden unless it is the open one; the current page's submenu says so. */
  panel: (label: string) => { style?: { display: "none" }; "data-active-submenu"?: string };
  /** A parent entry: active when it holds the current page; a click opens its submenu. */
  parent: (label: string) => { className: string; onClick: () => void };
  /** Back to the main menu. */
  back: () => void;
  /** Every menu list's class (`:class="navSwap && 'nav-swap-' + navSwap"`). */
  list: string;
}

export function sidebarMenu(
  state: { submenu: string; navSwap: NavSwap },
  active: string,
  set: (state: { submenu: string; navSwap: NavSwap }) => void,
): SidebarMenu {
  return {
    panel: (label) => ({
      ...(label === state.submenu ? {} : { style: { display: "none" as const } }),
      ...(label !== "" && label === active ? { "data-active-submenu": label } : {}),
    }),
    parent: (label) => ({
      className: label === active ? "menu-item w-full menu-item-active" : "menu-item w-full",
      onClick: () => set({ submenu: label, navSwap: "forward" }),
    }),
    back: () => set({ submenu: "", navSwap: "back" }),
    list: state.navSwap ? `flex flex-col gap-y-0.5 nav-swap-${state.navSwap}` : "flex flex-col gap-y-0.5",
  };
}
