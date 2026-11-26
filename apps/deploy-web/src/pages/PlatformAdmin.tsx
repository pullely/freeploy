// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/admin/index.blade.php,
// resources/views/livewire/team/admin-view.blade.php, resources/views/components/table-pagination.blade.php
// and app/Livewire/{Admin/Index,Team/AdminView}.php (Apache-2.0), modified.
//
// The platform operator's views of every user and team (freeploy-coolify-parity DP12), read only:
//   /admin        Admin: the current user, the subscriber counts and the user lookup (Admin\Index)
//   /team/admin   Team → Admin View: the instance's users, searched, filtered by the current team, sorted
//                 and paged (Team\AdminView)
// Not ported: "Switch user" — impersonating a customer would let the operator act as them inside their
// org, outside every org's own roles and audit — the "Impersonation is active" callout and "Return to
// root user" with it; and deleting a user from Admin View (an account is deleted by its owner, from the
// profile, with identity's rules). Anyone but an operator gets the API's 404 and Coolify's 404 page.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, FormInput, Listbox, SettingsSection, StatusBadge } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect } from "../components/CoolifyList";
import { TeamLayout } from "./Team";

interface PlatformUser {
  id: string;
  name: string | null;
  email: string;
  hasActiveSubscription: boolean;
}

/** abort(404): what a page of the platform shows to anyone who is not an operator. */
export function PlatformNotFound() {
  return (
    <main className="error-shell">
      <div className="error-shell-content">
        <p className="error-code">404</p>
        <h1 className="error-title">How did you get here?</h1>
        <p className="error-description">Sorry, we couldn't find the page you're looking for.</p>
        <div className="error-actions">
          <a href="/">
            <button type="button" className="button">
              Dashboard
            </button>
          </a>
        </div>
      </div>
    </main>
  );
}

/** Str::plural('matching user', $count). */
const matchingUsers = (n: number) => `${n} ${n === 1 ? "matching user" : "matching users"}`;

// ── /admin ──────────────────────────────────────────────────────────────

interface AdminData {
  activeSubscribers: number;
  inactiveSubscribers: number;
  search: string;
  users: PlatformUser[];
  total: number;
}

function Admin() {
  const { me } = useSignedIn();
  const [data, setData] = useState<AdminData | null>(null);
  const [missing, setMissing] = useState(false);
  const [search, setSearch] = useState("");
  const load = useCallback(async (q: string) => {
    const r = await getJson<AdminData>(`/v1/platform/admin${q ? `?search=${encodeURIComponent(q)}` : ""}`);
    if (!r.data) {
      if (r.status === 404) setMissing(true);
      else if (r.status !== 401) notify.error("Failed to load the users.");
      return;
    }
    setData(r.data);
  }, []);
  useEffect(() => void load(""), [load]);
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  const userName = me.user.displayName?.trim() || me.user.email;
  const card = "rounded-[10px] border border-neutral-200 bg-white p-4 dark:border-white/[0.07] dark:bg-surface";
  return (
    <div className="mt-8 flex w-full max-w-none flex-col gap-6 lg:mt-3">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className={card}>
          <div className="text-xs font-medium text-neutral-500 dark:text-fg-dim">Current user</div>
          <div className="mt-2 truncate text-sm font-semibold text-black dark:text-fg">{userName}</div>
          <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-fg-faint">{me.user.email}</div>
        </div>
        <div className={card}>
          <div className="text-xs font-medium text-neutral-500 dark:text-fg-dim">Active subscribers</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-black dark:text-fg">{data.activeSubscribers}</div>
        </div>
        <div className={card}>
          <div className="text-xs font-medium text-neutral-500 dark:text-fg-dim">Inactive subscribers</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-black dark:text-fg">{data.inactiveSubscribers}</div>
        </div>
      </section>

      <section className="application-settings-section">
        <div className="application-settings-section-header">
          <div>
            <h2>User lookup</h2>
            <p>Find an account for support or administration.</p>
          </div>
        </div>
        <div className="application-settings-section-body p-0!">
          <form
            className="flex items-end gap-2 border-b border-neutral-200 p-4 dark:border-white/[0.06]"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              // submitSearch(): an empty search keeps the last answer.
              if (search !== "") void load(search);
            }}
          >
            <div className="max-w-md flex-1">
              <FormInput label="Name or email" placeholder="Search for a user…" value={search} onChange={setSearch} />
            </div>
            <button type="submit" className="button">
              <Reicon name="search" className="size-4" />
              Search
            </button>
          </form>

          {data.search ? (
            data.users.length === 0 ? (
              <Empty size="sm" title="No users found" description={`No account matches ${data.search}.`} iconName="profile" />
            ) : (
              <div className="data-table">
                <div className="data-table-header admin-search-table-grid">
                  <span>Name</span>
                  <span>Email</span>
                  <span>Subscription</span>
                  <span className="text-right">Actions</span>
                </div>
                {data.users.map((user) => (
                  <div key={user.id} className="data-table-row admin-search-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.06]">
                    <div className="truncate text-[12px] font-semibold text-black dark:text-fg">{user.name ?? user.email}</div>
                    <div className="truncate text-[11px] text-neutral-600 dark:text-fg-dim">{user.email}</div>
                    <div>
                      <StatusBadge label={user.hasActiveSubscription ? "Active" : "Inactive"} type={user.hasActiveSubscription ? "success" : "neutral"} />
                    </div>
                    <div className="flex justify-end" />
                  </div>
                ))}
                <div className="flex min-h-11 items-center border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">{matchingUsers(data.total)}</div>
              </div>
            )
          ) : (
            <Empty size="sm" title="Search for an account" description="Enter a name or email address to begin." iconName="profile" />
          )}
        </div>
      </section>
    </div>
  );
}

export function AdminPage() {
  return (
    <Layout title="Admin" href="/admin">
      <Admin />
    </Layout>
  );
}

// ── /team/admin ─────────────────────────────────────────────────────────

interface UsersPage {
  users: PlatformUser[];
  total: number;
  page: number;
  perPage: number;
}

function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem("freeploy.page-size.team-admin"));
    return n >= 1 && n <= 100 ? n : 10;
  } catch {
    return 10;
  }
}

function TeamAdminView() {
  const { me } = useSignedIn();
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState("all");
  const [sort, setSort] = useState("name_asc");
  const [perPage, setPerPage] = useState(readPageSize);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsersPage | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    // wire:model.live.debounce.300ms on the search.
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ search: search.trim(), teamFilter, sort, perPage: String(perPage), page: String(page) });
      if (me.team) q.set("orgId", me.team.id);
      void getJson<UsersPage>(`/v1/platform/admin/users?${q.toString()}`).then((r) => {
        if (!r.data) {
          if (r.status === 404) setMissing(true);
          else if (r.status !== 401) notify.error("Failed to load the users.");
          return;
        }
        setData(r.data);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [search, teamFilter, sort, perPage, page, me.team]);
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  const lastPage = Math.max(1, Math.ceil(data.total / data.perPage));
  const from = data.total ? (data.page - 1) * data.perPage + 1 : 0;
  const to = Math.min(data.total, data.page * data.perPage);
  // updatedSearch / updatedTeamFilter / updatedSort / updatedPerPage: resetPage().
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  return (
    <TeamLayout role="admin">
      <div className="application-settings-form">
        <SettingsSection title="Instance users" flush>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
            }}
            className="flex flex-col gap-2 border-b border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08]"
          >
            <div className="relative w-full max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                type="search"
                placeholder="Search users"
                aria-label="Search users"
                value={search}
                onChange={(e) => reset(setSearch)(e.target.value)}
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
              <button
                type="button"
                onClick={() => reset(setSearch)("")}
                className={`absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg${search ? "" : " hidden"}`}
                aria-label="Clear search"
              >
                <Reicon name="x" className="size-3" />
              </button>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <div className="w-full sm:w-40">
                <Listbox
                  id="teamFilter"
                  options={[
                    { value: "all", label: "All users" },
                    { value: "current", label: "Current team" },
                    { value: "outside", label: "Outside team" },
                  ]}
                  value={teamFilter}
                  onChange={reset(setTeamFilter)}
                />
              </div>
              <div className="w-full sm:w-40">
                <Listbox
                  id="sort"
                  options={[
                    { value: "name_asc", label: "Name A–Z" },
                    { value: "name_desc", label: "Name Z–A" },
                    { value: "email_asc", label: "Email A–Z" },
                    { value: "email_desc", label: "Email Z–A" },
                  ]}
                  value={sort}
                  onChange={reset(setSort)}
                />
              </div>
            </div>
          </form>

          {data.users.length ? (
            <>
              <div className="data-table transition-opacity">
                <div className="data-table-header admin-users-table-grid">
                  <span>Name</span>
                  <span>Email</span>
                  <span className="text-right">Actions</span>
                </div>
                {data.users.map((user) => (
                  <div key={user.id} className="data-table-row admin-users-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-[11px] font-semibold text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">
                        {([...(user.name || user.email)][0] ?? "").toUpperCase()}
                      </div>
                      <span className="truncate text-[13px] font-medium text-black dark:text-fg">{user.name}</span>
                    </div>
                    <div className="truncate text-[12px] text-neutral-500 dark:text-fg-dim">{user.email}</div>
                    <div className="flex justify-end" />
                  </div>
                ))}
              </div>
              <footer className="pager flex min-h-14 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${from}-${to} of ${data.total}`}</span>
                  <PageSizeSelect
                    value={perPage}
                    onChange={(n) => {
                      const size = Math.max(1, Math.min(100, n));
                      try {
                        localStorage.setItem("freeploy.page-size.team-admin", String(size));
                      } catch {
                        /* storage blocked */
                      }
                      reset(setPerPage)(size);
                    }}
                    options={[10, 25, 50, 100]}
                  />
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setPage(1)} disabled={data.page <= 1} className={PAGER_BUTTON} aria-label="First page">
                    <Reicon name="arrow-right" className="size-3.5 rotate-180" />
                  </button>
                  <button type="button" onClick={() => setPage(data.page - 1)} disabled={data.page <= 1} className={PAGER_BUTTON} aria-label="Previous page">
                    <Reicon name="arrow-right" className="size-3.5 rotate-180" />
                  </button>
                  <button type="button" onClick={() => setPage(data.page + 1)} disabled={data.page >= lastPage} className={PAGER_BUTTON} aria-label="Next page">
                    <Reicon name="arrow-right" className="size-3.5" />
                  </button>
                  <button type="button" onClick={() => setPage(lastPage)} disabled={data.page >= lastPage} className={PAGER_BUTTON} aria-label="Last page">
                    <Reicon name="arrow-right" className="size-3.5" />
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <Empty title="No users found" description="Try a different name or email address." iconName="teams" size="sm" />
          )}
        </SettingsSection>
      </div>
    </TeamLayout>
  );
}

export function TeamAdminViewPage() {
  return (
    <Layout title="Team" href="/team" documentTitle="Team Admin">
      <TeamAdminView />
    </Layout>
  );
}
