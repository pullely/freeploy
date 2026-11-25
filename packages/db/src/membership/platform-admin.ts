// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Admin/Index.php (submitSearch, getSubscribers) and
// app/Livewire/Team/AdminView.php (render) (Apache-2.0), modified.
//
// The platform operator's view of every user and team (freeploy-coolify-parity DP12), read only:
// Coolify's Admin page (user lookup, subscriber counts) and Team → Admin View (the instance's users,
// searched, filtered by the current team, sorted, paged). Users are identity's (identity.users, read
// only, as team.ts and the support repository read them), teams and memberships are membership's, and
// a team's subscription is billing's (billing.subscriptions, read only). Nothing here writes.
//
// Only membership-worker's internal routes call these, for deploy-core-worker's platform routes, which
// policy-worker has authorized for a platform operator first.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Coolify's subscription is paid (stripe_invoice_paid); Freeploy's is in one of these states. */
const ACTIVE_SUBSCRIPTION = "('active', 'trialing')";

export type PlatformUserSort = "name_asc" | "name_desc" | "email_asc" | "email_desc";
export type PlatformTeamFilter = "all" | "current" | "outside";

export interface PlatformUsersQuery {
  /** Name or email, matched as Coolify's `like "%…%"` (case-sensitive on Postgres). Empty matches every user. */
  search: string;
  teamFilter: PlatformTeamFilter;
  /** The current team (membership.organizations.id) for teamFilter current and outside. */
  orgId: string | null;
  sort: PlatformUserSort;
  /** A user (identity.users.id) left out of the list: AdminView's `where('id', '!=', auth()->id())`. */
  excludeUserId: string | null;
  limit: number;
  offset: number;
}

export interface PlatformUserRecord {
  /** identity.users.id */
  userId: string;
  displayName: string | null;
  email: string;
  /** Admin\Index: one of the user's teams has a paid subscription. */
  hasActiveSubscription: boolean;
}

interface UserRow extends SqlRow {
  id: string;
  display_name: string | null;
  email: string;
  has_active_subscription: boolean;
  total: string | number;
}

const ORDER: Record<PlatformUserSort, string> = {
  name_asc: "u.display_name ASC",
  name_desc: "u.display_name DESC",
  email_asc: "u.email ASC",
  email_desc: "u.email DESC",
};

const SUBJECT = "'usr_' || replace(u.id::text, '-', '')";

/** The users of AdminView::render() and Admin\Index::submitSearch(), and how many match in all. */
export async function listPlatformUsers(db: SqlExecutor, q: PlatformUsersQuery): Promise<{ users: PlatformUserRecord[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = ["u.status <> 'deleted'"];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.excludeUserId) where.push(`u.id <> ${p(q.excludeUserId)}::uuid`);
  if (q.search !== "") {
    const s = p(q.search);
    where.push(`(u.display_name LIKE '%' || ${s} || '%' OR u.email LIKE '%' || ${s} || '%')`);
  }
  if (q.teamFilter !== "all" && q.orgId) {
    const member = `EXISTS (SELECT 1 FROM membership.organization_members m WHERE m.org_id = ${p(q.orgId)}::uuid AND m.subject_id = ${SUBJECT} AND m.status = 'active')`;
    where.push(q.teamFilter === "current" ? member : `NOT ${member}`);
  }
  const r = await db.execute<UserRow>(
    `SELECT u.id::text AS id, u.display_name, u.email,
       EXISTS (SELECT 1 FROM membership.organization_members m
         JOIN billing.subscriptions s ON replace(s.org_id, '-', '') = replace(m.org_id::text, '-', '')
         WHERE m.subject_id = ${SUBJECT} AND m.status = 'active' AND s.status IN ${ACTIVE_SUBSCRIPTION}) AS has_active_subscription,
       count(*) OVER () AS total
     FROM identity.users u
     WHERE ${where.join(" AND ")}
     ORDER BY ${ORDER[q.sort]}, u.created_at, u.id
     LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`,
    params,
  );
  let total = Number(r.rows[0]?.total ?? 0);
  if (!r.rows.length && q.offset > 0) {
    // Past the last page: count what matches without a page.
    const c = await db.execute<{ total: string | number }>(`SELECT count(*) AS total FROM identity.users u WHERE ${where.join(" AND ")}`, params.slice(0, -2));
    total = Number(c.rows[0]?.total ?? 0);
  }
  return {
    users: r.rows.map((row) => ({ userId: row.id, displayName: row.display_name, email: row.email, hasActiveSubscription: row.has_active_subscription === true })),
    total,
  };
}

/** Admin\Index::getSubscribers(): teams whose subscription is paid, and teams whose subscription is not. */
export async function countPlatformSubscribers(db: SqlExecutor): Promise<{ active: number; inactive: number }> {
  const r = await db.execute<{ active: string | number; inactive: string | number }>(
    `SELECT count(DISTINCT replace(org_id, '-', '')) FILTER (WHERE status IN ${ACTIVE_SUBSCRIPTION}) AS active,
            count(DISTINCT replace(org_id, '-', '')) FILTER (WHERE status NOT IN ${ACTIVE_SUBSCRIPTION}) AS inactive
     FROM billing.subscriptions`,
  );
  return { active: Number(r.rows[0]?.active ?? 0), inactive: Number(r.rows[0]?.inactive ?? 0) };
}
