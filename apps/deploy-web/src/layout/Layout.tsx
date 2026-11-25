// Derived from coollabsio/coolify@91b7e3e:resources/views/layouts/app.blade.php,
// resources/views/components/navbar.blade.php and
// resources/views/livewire/layout-popups.blade.php (Apache-2.0), modified.
//
// The signed-in layout: Coolify's markup (generated from the reference's
// rendered page) with the signed-in user, their team, the current page and the
// stored appearance bound in. A visitor without a session goes to /login, as
// Laravel's auth middleware sends them.
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LayoutMarkup } from "./generated/LayoutMarkup";
import { clearSession, edgeBase, getJson, postJson, sessionToken } from "../lib/api";
import { appearance, type PageWidth } from "../theme";
import { useDisclosures } from "./disclosures";
import { activeSubmenu, childActive, mainMenuActive, sidebarMenu, type NavSwap } from "./sidebar";
import { Toasts } from "./Toasts";
import { platformSlots } from "./PlatformMenu";
import { showMonthlyReminder } from "../lib/reminder";

export interface Me {
  user: { id: string; email: string; displayName: string | null; lastOrgSlug?: string | null };
  /** The current org; `id` is its public id (org_…), the path segment of /v1/organizations/{id}/…. */
  team: { id: string; name: string; slug: string } | null;
  /** The profile picture, when the user has one. */
  avatarUrl: string | null;
}

const MAIN = "app-main min-h-screen bg-neutral-50 dark:bg-app px-5 py-6 sm:px-8 lg:px-10 lg:pt-[calc(3rem+1.75rem)] lg:pb-10 lg:ml-56 transition-[margin] duration-200";

/** The signed-in user and team for pages inside the layout, and a way to update them after a save. */
export const MeContext = createContext<{ me: Me; setMe: (me: Me) => void } | null>(null);
export function useSignedIn(): { me: Me; setMe: (me: Me) => void } {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useSignedIn outside <Layout>");
  return ctx;
}

/** The session's user and their current team (the org they last worked in, else their first). */
export function useMe(): [Me | null, (me: Me) => void] {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!sessionToken()) {
      window.location.replace("/login");
      return;
    }
    void (async () => {
      const session = await getJson<{ user: Me["user"]; emailVerified?: boolean; verificationRequired?: boolean; avatarPath?: string | null }>("/v1/auth/session");
      if (!session.data) {
        if (session.status === 401) {
          clearSession();
          window.location.replace("/login");
        }
        return;
      }
      // Coolify Cloud (DecideWhatToDoWithUser): an unverified account only reaches /verify.
      if (session.data.verificationRequired && session.data.emailVerified === false) {
        window.location.replace("/verify");
        return;
      }
      const orgs = await getJson<{ organizations: Array<{ id: string; name: string; slug: string }> }>("/v1/organizations");
      const list = orgs.data?.organizations ?? [];
      const found = list.find((o) => o.slug === session.data!.user.lastOrgSlug) ?? list[0] ?? null;
      const team = found ? { id: found.id, name: found.name, slug: found.slug } : null;
      setMe({ user: session.data.user, team, avatarUrl: session.data.avatarPath ? edgeBase() + session.data.avatarPath : null });
    })();
  }, []);
  return [me, setMe];
}

function reminderDismissed(): boolean {
  try {
    return !showMonthlyReminder(localStorage.getItem("popupNotification"));
  } catch {
    return false; // storage blocked: show it, as Coolify does
  }
}

function initial(s: string): string {
  return (s.trim()[0] ?? "").toUpperCase();
}

export interface LayoutProps {
  /** The breadcrumb's page name and link (Coolify's page context). */
  title: string;
  href: string;
  /** The document title's page name, when it differs from the breadcrumb. */
  documentTitle?: string;
  /** The search button's tooltip: pages with searchable sections say so. */
  searchTitle?: string;
  /** Overlays a page teleports to <body> (dialogs, popups). */
  portal?: ReactNode;
  /** The main menu item to mark current, when it is not this page's path (a server's pages mark Servers). */
  navHref?: string;
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const [me, setMe] = useMe();
  const [pageWidth, setPageWidth] = useState<PageWidth>(() => appearance.pageWidth());
  const [reminderHidden, setReminderHidden] = useState(() => reminderDismissed());
  useDisclosures();
  // The sidebar (desktop) and the mobile drawer each keep their own open submenu, as each
  // navbar has its own Alpine state; both start on the submenu that holds this page.
  const path = window.location.pathname;
  // isInstanceAdmin(): whether the user is a platform operator (DP-79). Anyone else gets a 404 here and
  // keeps the sidebar of the reference; an operator's also has Settings, Admin and Team → Admin View.
  const [operator, setOperator] = useState(false);
  const active = activeSubmenu(path, operator);
  const [desktopNav, setDesktopNav] = useState<{ submenu: string; navSwap: NavSwap }>({ submenu: active, navSwap: "" });
  const [mobileNav, setMobileNav] = useState<{ submenu: string; navSwap: NavSwap }>({ submenu: active, navSwap: "" });
  useEffect(() => {
    if (!sessionToken()) return;
    void getJson<{ operator: boolean }>("/v1/platform/operator").then((r) => {
      if (r.data?.operator !== true) return;
      setOperator(true);
      // The sidebar starts on the submenu that holds this page, which may be one only an operator has.
      const opened = activeSubmenu(window.location.pathname, true);
      if (opened) {
        setDesktopNav({ submenu: opened, navSwap: "" });
        setMobileNav({ submenu: opened, navSwap: "" });
      }
    });
  }, []);
  useEffect(() => {
    document.title = `${props.documentTitle ?? props.title} | Freeploy`;
  }, [props.title, props.documentTitle]);
  useEffect(() => {
    const onWidth = (e: Event) => setPageWidth((e as CustomEvent<PageWidth>).detail);
    window.addEventListener("page-width-changed", onWidth);
    return () => window.removeEventListener("page-width-changed", onWidth);
  }, []);
  // @if (!currentTeam()->isAnyNotificationEnabled()): whether one of the org's channels is on (DP-67).
  // Unknown until the answer comes, and then the reminder stays hidden; a failed read shows it.
  const [notificationsOn, setNotificationsOn] = useState<boolean | null>(null);
  const teamId = me?.team?.id ?? null;
  useEffect(() => {
    if (!teamId) return;
    void getJson<{ anyEnabled: boolean }>(`/v1/organizations/${teamId}/deploy/notifications`).then((r) => setNotificationsOn(r.data ? r.data.anyEnabled : false));
  }, [teamId]);
  if (!me) return null;

  const userName = me.user.displayName?.trim() || me.user.email;
  const teamName = me.team?.name ?? "";
  async function onLogout(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await postJson("/v1/auth/logout", {});
    clearSession();
    window.location.assign("/login");
  }
  function dismissReminder() {
    try {
      localStorage.setItem("popupNotification", Date.now().toString());
    } catch {
      /* storage blocked */
    }
    setReminderHidden(true);
  }
  const here = props.navHref ?? (window.location.pathname.replace(/\/$/, "") || "/");
  const nav = (href: string): { className: string; "aria-current"?: "page" } =>
    href === here || childActive(path, href, operator) || mainMenuActive(path, href) ? { className: "menu-item menu-item-active", "aria-current": "page" } : { className: "menu-item" };
  return (
    <MeContext.Provider value={{ me, setMe }}>
    <LayoutMarkup
      pageTitle={props.title}
      pageHref={props.href}
      searchTitle={props.searchTitle ?? "Search (Press / or Ctrl+K)"}
      nav={nav}
      {...(operator ? { platform: platformSlots(nav) } : {})}
      desktopMenu={sidebarMenu(desktopNav, active, setDesktopNav)}
      mobileMenu={sidebarMenu(mobileNav, active, setMobileNav)}
      mainClass={pageWidth === "centered" ? MAIN : `${MAIN} app-main-wide`}
      teamName={teamName}
      teamInitial={initial(teamName)}
      userName={userName}
      userInitial={initial(userName)}
      userEmail={me.user.email}
      avatarUrl={me.avatarUrl}
      onLogout={onLogout}
      // The reminder: no channel is on, and it was not dismissed this month.
      {...(reminderHidden || notificationsOn !== false ? { reminderStyle: { display: "none" as const } } : {})}
      onDismissReminder={dismissReminder}
      portal={props.portal}
      toasts={<Toasts />}
    >
      <div className={pageWidth === "centered" ? "w-full mx-auto max-w-[1400px]" : "w-full max-w-none"}>{props.children}</div>
    </LayoutMarkup>
    </MeContext.Provider>
  );
}
