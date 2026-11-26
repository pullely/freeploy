// Derived from coollabsio/coolify@91b7e3e:resources/views/components/navbar.blade.php (Apache-2.0), modified.
//
// The sidebar entries Coolify shows its instance admin, which in Freeploy are the platform operator's
// (DP-79): the Settings submenu (navbar's `'visible' => $teamWide && isInstanceAdmin()`, after Tags), the
// Admin link (`auth()->id() === 0`, after the menu) and Team → Admin View (`'visible' => isInstanceAdmin()`).
// The reference's capture signs in as a tenant, so these are not in the generated LayoutMarkup; it renders
// them through its `platform` slots, and only for an operator (Layout asks GET /v1/platform/operator).
// Only the ported settings pages are listed (General, Advanced).
import type { ReactNode } from "react";
import { Reicon } from "../components/Reicon";
import type { SidebarMenu } from "./sidebar";

type Nav = (href: string) => { className: string; "aria-current"?: "page" };

const SETTINGS_CHILDREN: Array<{ label: string; href: string; icon: string }> = [
  { label: "General", href: "/settings", icon: "settings" },
  { label: "Advanced", href: "/settings/advanced", icon: "grid" },
];

function Link({ label, href, icon, nav, extraClass = "" }: { label: string; href: string; icon: string; nav: Nav; extraClass?: string }) {
  const n = nav(href);
  return (
    <a title={label} href={href} className={extraClass ? `${extraClass} ${n.className}` : n.className} {...(n["aria-current"] ? { "aria-current": n["aria-current"] } : {})}>
      <Reicon name={icon} className="menu-item-icon" />
      <span className="menu-item-label">{label}</span>
    </a>
  );
}

/** The LayoutMarkup `platform` slots for a platform operator. */
export function platformSlots(nav: Nav): {
  panel: (menu: SidebarMenu) => ReactNode;
  entry: (menu: SidebarMenu) => ReactNode;
  admin: (menu: SidebarMenu) => ReactNode;
  teamAdminView: ReactNode;
} {
  return {
    panel: (menu) => (
      <li className="contents" {...menu.panel("Settings")}>
        <ul role="list" className={menu.list}>
          <li className="mb-1">
            <button type="button" title="Back to the main menu" aria-label="Back to the main menu" className="menu-item menu-back bg-transparent! hover:bg-neutral-100! dark:hover:bg-white/[0.06]!" onClick={menu.back}>
              <span className="menu-back-icon flex shrink-0 items-center justify-center">
                <Reicon name="chevron-down" className="size-3 rotate-90 text-coollabs dark:text-fg-dim" />
              </span>
              <span className="flex-1 truncate pr-6 text-center font-medium text-black dark:text-fg">Settings</span>
            </button>
          </li>
          {SETTINGS_CHILDREN.map((c) => (
            <li key={c.href}>
              <Link label={c.label} href={c.href} icon={c.icon} nav={nav} />
            </li>
          ))}
        </ul>
      </li>
    ),
    entry: (menu) => (
      <li>
        <button type="button" title="Settings" {...menu.parent("Settings")}>
          <Reicon name="settings" className="menu-item-icon" />
          <span className="menu-item-label flex-1 text-left">Settings</span>
          <Reicon name="chevron-down" className="nav-chevron size-3 -rotate-90 text-coollabs dark:text-fg-faint" />
        </button>
      </li>
    ),
    // Part of the main menu: hidden while a submenu shows.
    admin: (menu) => (
      <li {...(menu.panel("").style ? { style: { display: "none" as const } } : {})}>
        <Link label="Admin" href="/admin" icon="fire" nav={nav} extraClass="nav-admin" />
      </li>
    ),
    teamAdminView: (
      <li>
        <Link label="Admin View" href="/team/admin" icon="admin" nav={nav} />
      </li>
    ),
  };
}
