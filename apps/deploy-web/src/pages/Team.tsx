// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/team/{index,member,invite-link,invitations}.blade.php,
// resources/views/livewire/team/member/index.blade.php, resources/views/components/team/{settings-layout,avatar}.blade.php,
// resources/views/components/{two-factor-badge,error-page}.blade.php, resources/views/invitation/accept.blade.php
// and app/Livewire/Team/{Index,Member,Invitations,InviteLink}.php (Apache-2.0), modified.
//
// The team pages, in the Team submenu of the sidebar:
//   /team            General: the team's name and description (Team\Index)
//   /team/members    Members, and for who can manage invitations "Invite a member" and "Pending invitations"
//   /invitations/{id}  showInvitation / acceptInvitation: the invited user's page
// Every action is the component's, run by membership-worker (handlers/team.ts): the page sends it and
// shows the answer's toast or the fields' errors. Not ported (see IMPLEMENTATION-STATUS.md, Notes on
// DP10): the team avatar upload, the MCP server, build server fallback and two-factor requirement
// listboxes, a member's access scopes (Edit access, Scopes, "Access: …"), and sending an invitation by
// email (Freeploy delivers no email yet, so "Send email" stays hidden as Coolify hides it).
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, sessionToken, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { AuthAlert } from "../components/AuthAlert";
import { Toasts } from "../layout/Toasts";
import { CopyButton, Empty, FormInput, Listbox, ModalConfirmation, SettingsSection, UnsavedBar } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect, TableDropdown } from "../components/CoolifyList";

export interface TeamData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  you: boolean;
  twoFactor: boolean | null;
}

interface MembersData {
  team: TeamData;
  role: string;
  canManageMembers: boolean;
  canManageInvitations: boolean;
  members: MemberRow[];
  membersWithoutTwoFactorCount: number | null;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  via: string;
  path: string;
  createdAt: string;
  expired: boolean;
}

export const teamApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/team`;
const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** <x-team.settings-layout>: the mobile title and the team pages fed to the page search. */
export function TeamLayout({ role, children }: { role: string | null; children: ReactNode }) {
  const origin = window.location.origin;
  const pages: Array<[string, string, string]> = [
    ["General", "/team", "settings"],
    ["Members", "/team/members", "teams"],
    ...(role === "owner" || role === "admin" ? [["Audit log", "/team/audit-log", "time-back"] as [string, string, string]] : []),
    ["Image Scanning", "/team/image-scanning", "shield-alert"],
    ...(role === "owner" ? [["Danger Zone", "/team/danger", "danger"] as [string, string, string]] : []),
  ];
  const items = JSON.stringify(pages.map(([label, path]) => ({ label, breadcrumb: "Team", search_text: `${label} Team`, href: origin + path, navigate: true })));
  return (
    <section className="w-full max-w-none">
      <header className="settings-mobile-header xl:hidden">
        <h1 className="settings-mobile-title">Team</h1>
        <p className="settings-mobile-description">Manage your team, members, and access settings.</p>
      </header>
      <div hidden data-settings-search-items={items} />
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function initial(name: string): string {
  return ([...name][0] ?? "").toUpperCase();
}

// ── /team ───────────────────────────────────────────────────────────────

function TeamGeneral() {
  const { me, setMe } = useSignedIn();
  const base = teamApi(me.team?.id);
  const [team, setTeam] = useState<TeamData | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [saved, setSaved] = useState({ name: "", description: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [r, members] = await Promise.all([getJson<{ team: TeamData; canUpdate: boolean }>(base), getJson<MembersData>(`${base}/members`)]);
      if (!r.data) {
        if (r.status !== 401) notify.error("Failed to load the team.");
        return;
      }
      const details = { name: r.data.team.name, description: r.data.team.description ?? "" };
      setTeam(r.data.team);
      setCanUpdate(r.data.canUpdate);
      setForm(details);
      setSaved(details);
      setRole(members.data?.role ?? null);
    })();
  }, [base]);

  /** Team\Index::submit(): validate, authorize update, save, dispatch('success', 'Team updated.'). */
  const submit = useCallback(async () => {
    setSaving(true);
    const r = await postJson<{ team: TeamData; message: string }>(base, { name: form.name, description: form.description }, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const f of ["name", "description"]) if (r.error.fields?.[f]?.[0]) inline[f] = r.error.fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    const details = { name: r.data.team.name, description: r.data.team.description ?? "" };
    setTeam(r.data.team);
    setForm(details);
    setSaved(details);
    // refreshSession() and 'team-updated': the team switcher shows the new name.
    if (me.team) setMe({ ...me, team: { ...me.team, name: r.data.team.name } });
    notify.success(r.data.message);
  }, [base, form, me, setMe]);

  if (!team) return null;
  const dirty = form.name !== saved.name || form.description !== saved.description;
  return (
    <TeamLayout role={role}>
      <div className="flex flex-col gap-6">
        <form
          className="application-settings-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (canUpdate) void submit();
          }}
        >
          <UnsavedBar dirty={dirty && canUpdate} saving={saving} onSave={() => void submit()} />
          <SettingsSection title="General" helper="Manage this team's identity and shared API access.">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <div className="mb-2 text-sm font-medium leading-4">Avatar</div>
                <div className="flex items-center gap-4">
                  <span className="flex shrink-0 items-center justify-center rounded-md bg-neutral-200 font-semibold text-neutral-700 dark:bg-white/[0.1] dark:text-fg size-16 rounded-xl! text-2xl">{initial(team.name)}</span>
                </div>
              </div>
              <FormInput id="name" label="Name" required value={form.name} onChange={(name) => setForm({ ...form, name })} disabled={!canUpdate} error={errors.name} />
              <FormInput id="description" label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} disabled={!canUpdate} error={errors.description} />
            </div>
          </SettingsSection>
        </form>
      </div>
    </TeamLayout>
  );
}

export function TeamGeneralPage() {
  return (
    <Layout title="Team" href="/team" documentTitle="Teams">
      <TeamGeneral />
    </Layout>
  );
}

// ── /team/members ───────────────────────────────────────────────────────

/** <x-two-factor-badge>. */
function TwoFactorBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      title={enabled ? "Two-factor authentication is enabled for this account." : "This account is not protected by two-factor authentication."}
      className={`inline-flex items-center ${enabled ? "text-green-600 dark:text-green-400" : "text-neutral-400 dark:text-fg-faint"}`}
    >
      {enabled ? (
        <svg className="size-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
          />
        </svg>
      ) : (
        <span className="text-[12px]" aria-hidden="true">
          Off
        </span>
      )}
      <span className="sr-only">Two-factor authentication is {enabled ? "enabled" : "disabled"}</span>
    </span>
  );
}

/** <x-table.sort-header> over a plain sort value. */
export function Sort(props: { label: string; asc: string; desc: string; first?: "asc" | "desc"; sortBy: string; onSort: (v: string) => void; className?: string }) {
  const firstValue = props.first === "desc" ? props.desc : props.asc;
  const otherValue = props.first === "desc" ? props.asc : props.desc;
  const sorted = props.sortBy === props.asc || props.sortBy === props.desc;
  const aria = `Sort by ${props.label.toLowerCase()}` + (props.sortBy === props.asc ? ", sorted ascending" : props.sortBy === props.desc ? ", sorted descending" : "");
  return (
    <button type="button" onClick={() => props.onSort(props.sortBy === firstValue ? otherValue : firstValue)} aria-label={aria} className={`table-sort-header group${sorted ? " is-sorted" : ""}${props.className ? ` ${props.className}` : ""}`}>
      <span className="truncate">{props.label}</span>
      <svg className={["table-sort-header-icon", sorted ? "is-visible" : "", props.sortBy === props.desc ? "rotate-180" : ""].filter(Boolean).join(" ")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 15l6-6 6 6" />
      </svg>
    </button>
  );
}

function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem("freeploy.page-size.team-members"));
    return n >= 1 && n <= 100 ? n : 10;
  } catch {
    return 10;
  }
}

/** The x-data of member/index.blade.php: search, role filter, sort and pages of 10. */
function useMembers(members: MemberRow[]) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name-asc");
  const [page, setPage] = useState(1);
  const [perPage, setPerPageValue] = useState(readPageSize);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = members.filter((m) => (!query || [m.name, m.email, m.role].some((v) => String(v ?? "").toLowerCase().includes(query))) && (roleFilter === "all" || m.role === roleFilter));
    const [column, direction] = sortBy.split("-");
    const order = direction === "desc" ? -1 : 1;
    const byName = (l: MemberRow, r: MemberRow) => l.name.localeCompare(r.name);
    const compare =
      { email: (l: MemberRow, r: MemberRow) => String(l.email ?? "").localeCompare(String(r.email ?? "")), role: (l: MemberRow, r: MemberRow) => (RANK[l.role] ?? 0) - (RANK[r.role] ?? 0), twofa: (l: MemberRow, r: MemberRow) => Number(l.twoFactor) - Number(r.twoFactor) }[column ?? ""] ?? byName;
    return rows.sort((l, r) => order * compare(l, r) || byName(l, r));
  }, [members, search, roleFilter, sortBy]);
  const lastPage = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, lastPage);
  const start = (current - 1) * perPage;
  return {
    search,
    setSearch: (v: string) => (setSearch(v), setPage(1)),
    roleFilter,
    setRoleFilter: (v: string) => (setRoleFilter(v), setPage(1)),
    sortBy,
    setSortBy: (v: string) => (setSortBy(v), setPage(1)),
    page: current,
    goToPage: (p: number) => setPage(Math.min(Math.max(p, 1), lastPage)),
    lastPage,
    perPage,
    setPerPage: (n: number) => {
      setPerPageValue(n);
      setPage(1);
      try {
        localStorage.setItem("freeploy.page-size.team-members", String(n));
      } catch {
        /* storage blocked */
      }
    },
    filtered,
    visible: filtered.slice(start, start + perPage),
    first: filtered.length === 0 ? 0 : start + 1,
    last: Math.min(current * perPage, filtered.length),
  };
}

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];
const SORT_OPTIONS = [
  { value: "name-asc", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "email-asc", label: "Email A–Z" },
  { value: "email-desc", label: "Email Z–A" },
  { value: "role-desc", label: "Role" },
];

function MemberActions({ member, actorRole, run }: { member: MemberRow; actorRole: string; run: (member: MemberRow, action: string | null) => Promise<void> }) {
  const remove = (trigger: ReactNode) => (
    <ModalConfirmation
      title="Remove team member?"
      trigger={trigger}
      actions={["This user loses access to all resources of this team."]}
      confirmationText={null}
      step2ButtonText="Remove member"
      onSubmit={async () => run(member, null)}
    />
  );
  if (member.role === "owner" && actorRole !== "owner") {
    return remove(
      <button type="button" className="icon-button shrink-0 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" title="Remove member" aria-label={`Remove ${member.name}`}>
        <Reicon name="trash" className="size-3.5" />
      </button>,
    );
  }
  const items: Array<[string, string]> = [];
  if (actorRole === "owner") {
    if (member.role !== "owner") items.push(["makeOwner", "Make owner"]);
    if (member.role !== "admin") items.push(["makeAdmin", "Make admin"]);
    if (member.role !== "member") items.push(["makeReadonly", "Make member"]);
  } else if (actorRole === "admin") {
    if (member.role === "admin") items.push(["makeReadonly", "Make member"]);
    else if (member.role === "member") items.push(["makeAdmin", "Make admin"]);
  }
  return (
    <TableDropdown
      panelClass="w-44!"
      trigger={(open) => (
        <button type="button" className="icon-button" title="Member actions" aria-label="Member actions" aria-haspopup="menu" aria-expanded={open}>
          <Reicon name="dots-horizontal" className="size-4" />
        </button>
      )}
    >
      {(close) => (
        <div className="contents">
          {items.map(([action, label]) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="listbox-option justify-start!"
              onClick={() => {
                close();
                void run(member, action);
              }}
            >
              {label}
            </button>
          ))}
          {items.length ? <div className="my-1 border-t border-neutral-200 dark:border-white/[0.08]" /> : null}
          <div className="row-actions-danger contents" onClick={close}>
            {remove(
              <button type="button" role="menuitem" className="listbox-option justify-start!">
                Remove member
              </button>,
            )}
          </div>
        </div>
      )}
    </TableDropdown>
  );
}

/** <livewire:team.invite-link>: generate a link (the only way until email is delivered). */
function InviteLink({ base, actorRole, onCreated }: { base: string; actorRole: string; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function viaLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<{ message: string }>(`${base}/invitations`, { email, role, via: "link" });
    setBusy(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const f of ["email", "role"]) if (r.error.fields?.[f]?.[0]) inline[f] = r.error.fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    notify.success(r.data.message);
    onCreated();
  }
  const options = [...(actorRole === "owner" ? [{ value: "owner", label: "Owner" }] : []), { value: "admin", label: "Admin" }, { value: "member", label: "Member" }];
  return (
    <form onSubmit={(e) => void viaLink(e)}>
      <SettingsSection
        title="Invite a member"
        helper="Create a reusable invitation link or deliver it by email."
        actions={
          <button type="submit" className="button button-highlighted" disabled={busy}>
            <Reicon name="plus" className="size-3.5" />
            Generate link
          </button>
        }
      >
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <FormInput id="email" type="email" label="Email address" placeholder="teammate@example.com" required value={email} onChange={setEmail} error={errors.email} />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Listbox id="role" label="Role" options={options} value={role} onChange={setRole} error={errors.role} />
            </div>
          </div>
        </div>
      </SettingsSection>
    </form>
  );
}

/** <livewire:team.invitations>: the pending invitations, their link, and revoking one. */
function Invitations({ base, invitations, onChange }: { base: string; invitations: InvitationRow[]; onChange: () => void }) {
  const [sort, setSort] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (sort === null) return invitations;
    const [column, direction] = sort.split("-");
    const order = direction === "desc" ? -1 : 1;
    const value = (i: InvitationRow): string | number => (column === "role" ? (RANK[i.role] ?? 0) : String(i[column as "email" | "via"]).toLowerCase());
    return [...invitations].sort((l, r) => {
      const a = value(l);
      const b = value(r);
      return order * (a < b ? -1 : a > b ? 1 : 0) || l.email.toLowerCase().localeCompare(r.email.toLowerCase());
    });
  }, [invitations, sort]);
  if (!invitations.length) return null;
  async function revoke(invite: InvitationRow) {
    const r = await postJson<{ message: string }>(`${base}/invitations/${encodeURIComponent(invite.id)}`, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    onChange();
    notify.success(r.data.message);
  }
  const grid = "grid-cols-[minmax(13rem,1fr)_7rem_10rem_4rem_4.5rem]";
  return (
    <SettingsSection title="Pending invitations" helper="Invitation links that have not been accepted yet." flush>
      <div className="overflow-x-auto">
        <div className="data-table min-w-[600px] transition-opacity">
          <div className={`data-table-header ${grid}`}>
            <Sort label="Email" asc="email-asc" desc="email-desc" sortBy={sort ?? ""} onSort={setSort} />
            <Sort label="Method" asc="via-asc" desc="via-desc" sortBy={sort ?? ""} onSort={setSort} />
            <Sort label="Role" asc="role-asc" desc="role-desc" first="desc" sortBy={sort ?? ""} onSort={setSort} />
            <span>Link</span>
            <span className="text-right">Actions</span>
          </div>
          {rows.map((invite) => (
            <div key={invite.id} className={`data-table-row ${grid} border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]`}>
              <div className="truncate text-[12px] font-medium text-black dark:text-fg">{invite.email}</div>
              <div className="text-[12px] capitalize text-neutral-500 dark:text-fg-dim">{invite.via}</div>
              <div className="min-w-0 text-[12px] text-neutral-500 dark:text-fg-dim">
                <div className="capitalize">{invite.role}</div>
              </div>
              <div className="flex items-center">
                <CopyButton value={window.location.origin + invite.path} label="Copy invitation link" />
              </div>
              <div className="flex justify-end">
                <ModalConfirmation
                  title="Revoke invitation?"
                  trigger={
                    <button type="button" className="icon-button shrink-0 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" title="Revoke invitation" aria-label={`Revoke invitation for ${invite.email}`}>
                      <Reicon name="trash" className="size-3.5" />
                    </button>
                  }
                  actions={[`The invitation link for ${invite.email} stops working.`]}
                  confirmationText={null}
                  step2ButtonText="Revoke invitation"
                  onSubmit={() => revoke(invite)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function TeamMembers() {
  const { me } = useSignedIn();
  const base = teamApi(me.team?.id);
  const [data, setData] = useState<MembersData | null>(null);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const load = useCallback(async () => {
    const r = await getJson<MembersData>(`${base}/members`);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load the team members.");
      return;
    }
    setData(r.data);
    // Member\Index::mount(): the invitations only for who can manage them.
    if (r.data.canManageInvitations) {
      const inv = await getJson<{ invitations: InvitationRow[] }>(`${base}/invitations`);
      setInvitations(inv.data?.invitations ?? []);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  const list = useMembers(data?.members ?? []);
  const refreshInvitations = useCallback(async () => {
    const inv = await getJson<{ invitations: InvitationRow[] }>(`${base}/invitations`);
    setInvitations(inv.data?.invitations ?? []);
  }, [base]);

  /** Member::makeOwner / makeAdmin / makeReadonly (action) or remove (null); then reloadWindow, or the error toast. */
  const run = useCallback(
    async (member: MemberRow, action: string | null) => {
      const path = `${base}/members/${encodeURIComponent(member.id)}`;
      const r = action ? await postJson(path, { action }, "PATCH") : await postJson(path, {}, "DELETE");
      if (!r.ok) return notify.error(r.error.messages[0] ?? "Something went wrong.");
      window.location.reload();
    },
    [base],
  );

  if (!data) return null;
  const manage = data.canManageMembers;
  const total = data.members.length;
  const without = data.membersWithoutTwoFactorCount ?? 0;
  const gridClass = `team-members-table-grid${manage ? " team-members-table-grid-2fa" : ""}`;
  return (
    <TeamLayout role={data.role}>
      <div className="application-settings-form flex flex-col gap-6">
        <SettingsSection title="Members" flush>
          <div className="flex flex-col gap-2 border-b border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08]">
            <div className="relative w-full max-w-sm">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                value={list.search}
                onChange={(e) => list.setSearch(e.target.value)}
                type="search"
                placeholder="Search members"
                aria-label="Search members"
                className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
              />
              {list.search ? (
                <button
                  onClick={() => list.setSearch("")}
                  type="button"
                  className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
                  aria-label="Clear search"
                >
                  <Reicon name="x" className="size-3" />
                </button>
              ) : null}
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <div className="w-full sm:w-36">
                <Listbox id="member-role-filter" options={ROLE_OPTIONS} value={list.roleFilter} onChange={list.setRoleFilter} />
              </div>
              <div className="w-full sm:w-40 min-[901px]:hidden">
                <Listbox id="member-sort" options={SORT_OPTIONS} value={list.sortBy} onChange={list.setSortBy} />
              </div>
            </div>
          </div>

          {manage ? (
            <div className="border-b border-neutral-200 px-4 py-2.5 text-[12px] dark:border-white/[0.08]">
              {without > 0 ? (
                <span className="text-warning-700 dark:text-warning">
                  {without} of {total} {total === 1 ? "member" : "members"} {without === 1 ? "does" : "do"} not have two-factor authentication enabled.
                </span>
              ) : (
                <span className="text-neutral-500 dark:text-fg-dim">All members have two-factor authentication enabled.</span>
              )}
            </div>
          ) : null}

          {list.filtered.length > 0 ? (
            <div className="data-table flex flex-col">
              <div className={`data-table-header ${gridClass}`}>
                <Sort label="Name" asc="name-asc" desc="name-desc" sortBy={list.sortBy} onSort={list.setSortBy} />
                <Sort label="Email" asc="email-asc" desc="email-desc" sortBy={list.sortBy} onSort={list.setSortBy} />
                <Sort label="Role" asc="role-asc" desc="role-desc" first="desc" sortBy={list.sortBy} onSort={list.setSortBy} />
                {manage ? <Sort label="2FA" asc="twofa-asc" desc="twofa-desc" sortBy={list.sortBy} onSort={list.setSortBy} /> : null}
                <span className="text-right">Actions</span>
              </div>
              {list.visible.map((member) => (
                <div key={member.id} className={`data-table-row ${gridClass} border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]`}>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-[11px] font-semibold text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">{initial(member.name || member.email || "")}</div>
                      <span className="truncate text-[13px] font-medium text-black dark:text-fg">{member.name}</span>
                      {member.you ? <span className="rounded-full bg-coollabs/10 px-1.5 py-0.5 text-[10px] font-medium text-coollabs dark:bg-brand/15 dark:text-brand-light">You</span> : null}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-neutral-500 dark:text-fg-dim">{member.email}</div>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="table-filter-value table-filter-badge inline-flex rounded-full border border-transparent bg-neutral-100 px-2 py-0.5 text-[10px] font-medium capitalize text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim"
                      title={`Filter by ${member.role}`}
                      onClick={() => list.setRoleFilter(list.roleFilter === member.role ? "all" : member.role)}
                    >
                      {member.role}
                    </button>
                  </div>
                  {manage ? (
                    <div className="flex items-center">
                      <TwoFactorBadge enabled={member.twoFactor === true} />
                    </div>
                  ) : null}
                  <div className="flex justify-end">{manage && !member.you ? <MemberActions member={member} actorRole={data.role} run={run} /> : null}</div>
                </div>
              ))}
            </div>
          ) : (
            <div>
              <Empty size="sm" title="No matching members" description="Try a different name, email address, or role." />
            </div>
          )}

          <footer
            hidden={list.filtered.length <= 10}
            className="pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint"
            style={list.filtered.length > 0 ? undefined : { display: "none" }}
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${list.first}-${list.last} of ${list.filtered.length}`}</span>
              <PageSizeSelect value={list.perPage} onChange={list.setPerPage} options={[10, 25, 50, 100]} />
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => list.goToPage(list.page - 1)} disabled={list.page === 1} className={PAGER_BUTTON} aria-label="Previous page">
                <Reicon name="arrow-right" className="size-3.5 rotate-180" />
              </button>
              <button type="button" onClick={() => list.goToPage(list.page + 1)} disabled={list.page >= list.lastPage} className={PAGER_BUTTON} aria-label="Next page">
                <Reicon name="arrow-right" className="size-3.5" />
              </button>
            </div>
          </footer>
        </SettingsSection>

        {data.canManageInvitations ? (
          <>
            <InviteLink base={base} actorRole={data.role} onCreated={() => void refreshInvitations()} />
            <Invitations base={base} invitations={invitations} onChange={() => void refreshInvitations()} />
          </>
        ) : null}
      </div>
    </TeamLayout>
  );
}

export function TeamMembersPage() {
  return (
    <Layout title="Team" href="/team/members" documentTitle="Team Members">
      <TeamMembers />
    </Layout>
  );
}

// ── /invitations/{id} ───────────────────────────────────────────────────

/** <x-error-page code="400" title="Bad request">: abort(400, $message). */
function BadRequest({ message }: { message: string }) {
  return (
    <main className="error-shell">
      <div className="error-shell-content">
        <p className="error-code">400</p>
        <h1 className="error-title">Bad request</h1>
        <p className="error-description">{message}</p>
        <div className="error-actions">
          <button type="button" className="button" onClick={() => window.history.back()}>
            Go back
          </button>
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

interface InvitationShown {
  team: { id: string; name: string; slug: string };
  role: string;
  alreadyMember: boolean;
}

/** invitation/accept.blade.php: the team and role, then Accept (or Dismiss when already a member). */
export function InvitationPage() {
  const id = decodeURIComponent(window.location.pathname.replace(/\/+$/, "").split("/").pop() ?? "");
  const api = `/v1/team-invitations/${encodeURIComponent(id)}`;
  const [shown, setShown] = useState<InvitationShown | null>(null);
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = !!sessionToken();
  useEffect(() => {
    if (!signedIn) {
      window.location.replace("/login");
      return;
    }
    void (async () => {
      // showInvitation(): a refusal's message is the page (abort(400, …)).
      const r = await postJson<InvitationShown>(api, undefined, "GET");
      if (r.ok) setShown(r.data);
      else if (r.error.status === 401) window.location.replace("/login");
      else setFailure({ status: r.error.status, message: r.error.messages[0] ?? "" });
    })();
  }, [api, signedIn]);

  async function accept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const r = await postJson<InvitationShown>(api, {});
    if (!r.ok) {
      setBusy(false);
      if (r.error.status === 400 || r.error.status === 404) return setFailure({ status: r.error.status, message: r.error.messages[0] ?? "" });
      return notify.error(summarize(r.error.messages));
    }
    // refreshSession($invitation->team): the invited team becomes the current one, then redirect to team.index.
    await postJson("/v1/auth/profile", { lastOrgSlug: r.data.team.slug }, "PATCH");
    window.location.assign("/team");
  }

  if (!signedIn) return null;
  if (failure) return failure.status === 400 ? <BadRequest message={failure.message} /> : <NotFoundPage />;
  if (!shown) return null;
  return (
    <>
      <main className="h-full bg-neutral-50 dark:bg-base">
        <section className="auth-shell application-settings-form">
          <div className="auth-shell-content">
            <div className="auth-card">
              <div className="auth-card-heading">
                <h1>Freeploy</h1>
                <p>Review your invitation to join a team.</p>
              </div>
              <div className="auth-card-body">
                <div className="flex flex-col gap-4">
                  <div className="auth-guidance">
                    <Reicon name="teams" className="mt-0.5 size-4 shrink-0" />
                    <p>You have been invited to collaborate on Freeploy.</p>
                  </div>
                  <dl className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-white/10 dark:border-white/10">
                    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                      <dt className="text-neutral-500 dark:text-fg-dim">Team</dt>
                      <dd className="min-w-0 truncate font-medium text-neutral-900 dark:text-white">{shown.team.name}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                      <dt className="text-neutral-500 dark:text-fg-dim">Role</dt>
                      <dd className="font-medium text-neutral-900 dark:text-white">{capitalize(shown.role)}</dd>
                    </div>
                  </dl>
                  {shown.alreadyMember ? <AuthAlert type="warning">You are already a member of this team. Dismiss the invitation to continue.</AuthAlert> : null}
                  <form onSubmit={(e) => void accept(e)}>
                    <button {...({ ishighlighted: "" } as object)} className="button w-full justify-center" type="submit" disabled={busy}>
                      {shown.alreadyMember ? "Dismiss invitation" : "Accept invitation"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Toasts />
    </>
  );
}

/** abort(404) of firstOrFail(). */
function NotFoundPage() {
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
