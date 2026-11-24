// Derived from coollabsio/coolify@91b7e3e:resources/views/components/navbar.blade.php (Apache-2.0), modified.
//
// The sidebar's submenus. An entry with children opens a submenu in place of
// the main menu; the sidebar starts on the submenu that holds the current page
// (a child whose `request()->is(...)` patterns match the path), else on the
// main menu. Each submenu's Back shows the main menu, and a parent entry opens
// its submenu, without leaving the page; `navSwap` ('forward' or 'back') picks
// the enter animation of every menu list.
//
// Only the entries the reference renders are listed (a non-admin's sidebar:
// no Settings submenu, no Team → Admin View).

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

/** The submenu holding the current page ('' for the main menu). */
export function activeSubmenu(pathname: string): string {
  return SUBMENUS.find((s) => s.children.some((c) => requestIs(pathname, c.is)))?.label ?? "";
}

/** Whether a submenu child is the current page. */
export function childActive(pathname: string, href: string): boolean {
  const child = SUBMENUS.flatMap((s) => s.children).find((c) => c.href === href);
  return child ? requestIs(pathname, child.is) : false;
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
