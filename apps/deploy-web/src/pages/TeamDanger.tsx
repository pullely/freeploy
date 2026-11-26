// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/team/danger-zone.blade.php,
// resources/views/errors/403.blade.php and app/Livewire/Team/DangerZone.php (Apache-2.0), modified.
//
// /team/danger: the team's Danger Zone (DP-75). Its state and the deletion are membership-worker's
// (handlers/team.ts: GET …/team/danger, DELETE …/team). The blade's branches, in its order: not the
// owner (the API answers 404, so the page is Coolify's 403 of mount()'s authorize), the last or personal
// team, what the team still owns, or the deletion. Freeploy has no root team (id 0) and no Cloud
// subscription, so those branches are not here. What Coolify deletes with the team (private keys, S3
// storages, cloud tokens, cloud-init scripts, tags, shared variables) holds the team in Freeploy and is
// listed with the blockers, in Freeploy's words. Deleting keeps the organization's row (marked deleted),
// so the confirmation does not say "and the database".
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { DangerZone, ModalConfirmation, SettingsSection } from "../components/Coolify";
import { TeamLayout, teamApi, type TeamData } from "./Team";

interface DangerData {
  team: TeamData;
  role: string;
  personal: boolean;
  state: "not-owner" | "last-or-personal" | "blocked" | "deletable";
  blockers: Partial<Record<"projects" | "servers" | "sources", number>>;
  owned: Partial<Record<"privateKeys" | "storages" | "cloudTokens" | "cloudInitScripts" | "tags" | "sharedVariables", number>>;
  projects: Array<{ uuid: string; name: string }>;
  servers: Array<{ uuid: string; name: string }>;
}

/** $blockerDetails, then the records Coolify deletes with the team (Freeploy's labels). */
const BLOCKER_DETAILS: Record<string, { label: string; route: string }> = {
  projects: { label: "project", route: "/projects" },
  servers: { label: "server", route: "/servers" },
  sources: { label: "Git source", route: "/sources" },
  privateKeys: { label: "private key", route: "/security/private-key" },
  storages: { label: "S3 storage", route: "/storages" },
  cloudTokens: { label: "cloud token", route: "/security/cloud-tokens" },
  cloudInitScripts: { label: "cloud-init script", route: "/security/cloud-init-scripts" },
  tags: { label: "tag", route: "/tags" },
  sharedVariables: { label: "shared variable", route: "/shared-variables" },
};

/** str($label)->plural($count) for these labels (all regular). */
const plural = (label: string, count: number) => (count === 1 ? label : `${label}s`);

const LINK = "font-medium text-coollabs hover:underline dark:text-brand-light";

/** <x-error-page code="403">: abort 403 of mount()'s authorize('delete'). */
export function Forbidden() {
  return (
    <main className="error-shell">
      <div className="error-shell-content">
        <p className="error-code">403</p>
        <h1 className="error-title">You shall not pass!</h1>
        <p className="error-description">You don't have permission to access this page.</p>
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

function TeamDangerZone() {
  const { me } = useSignedIn();
  const base = teamApi(me.team?.id);
  const [data, setData] = useState<DangerData | null>(null);
  const [denied, setDenied] = useState(false);

  /** mount() and refreshResources(). */
  const load = useCallback(async () => {
    const r = await getJson<DangerData>(`${base}/danger`);
    if (r.data) return setData(r.data);
    if (r.status === 404) return setDenied(true);
    if (r.status !== 401) notify.error("Failed to load the team.");
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  /** DangerZone::delete(): DeleteTeam, refreshSession($newTeam), redirect to team.index. */
  async function remove() {
    const r = await postJson<{ deleted: string }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    // The next team is the one the layout resolves: the user's last one if it still exists, else their first.
    window.location.assign("/team");
  }

  if (denied) return <Forbidden />;
  if (!data) return null;
  const blockers = [...Object.entries(data.blockers), ...Object.entries(data.owned)] as Array<[string, number]>;
  const resources = data.projects.length > 0 || data.servers.length > 0;
  return (
    <TeamLayout role={data.role}>
      <div className="application-settings-form">
        <SettingsSection id="team-danger-zone" title="Danger zone" helper="Destructive actions for this team cannot be undone.">
          <DangerZone
            title="Delete team"
            action={
              data.state === "deletable" ? (
                <ModalConfirmation
                  title="Confirm Team Deletion?"
                  buttonTitle="Delete team"
                  actions={["The current team will be permanently deleted from Freeploy."]}
                  confirmationText={data.team.name}
                  confirmationLabel="Enter the team name to confirm permanent deletion"
                  shortConfirmationLabel="Team name"
                  step2ButtonText="Permanently Delete"
                  onSubmit={remove}
                />
              ) : (
                <button className="button button-error" type="button" disabled title="Resolve the requirements shown before deleting this team.">
                  Delete team
                </button>
              )
            }
          >
            {data.state === "not-owner" ? (
              <p>Only team owners can delete this team.</p>
            ) : data.state === "last-or-personal" ? (
              <p>Your last or personal team cannot be deleted.</p>
            ) : data.state === "deletable" ? (
              <>
                <p>
                  Permanently delete <strong className="font-semibold text-black dark:text-fg">{data.team.name}</strong> from Freeploy. This action cannot be undone.
                </p>
                <ul className="space-y-1 text-xs">
                  <li>• All members will lose access to this team.</li>
                  <li>• This team cannot be restored from Freeploy after deletion.</li>
                </ul>
              </>
            ) : (
              <>
                <p>This team still owns:</p>
                <ul className="space-y-1">
                  {blockers.map(([type, count]) => (
                    <li key={type}>
                      <a className={LINK} href={BLOCKER_DETAILS[type]?.route ?? "/"}>
                        {count} {plural(BLOCKER_DETAILS[type]?.label ?? type, count)}
                      </a>
                    </li>
                  ))}
                </ul>
                <p>Remove or move these resources before deleting the team.</p>
              </>
            )}
          </DangerZone>

          {resources ? (
            <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 dark:border-white/[0.08]">
              <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-3 py-2 dark:border-white/[0.08]">
                <h5 className="text-sm font-medium text-black dark:text-fg">Resources</h5>
                <button type="button" className="button" onClick={() => void load()}>
                  <Reicon name="refresh" className="size-3.5" />
                  Refresh
                </button>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500 dark:bg-coolgray-100 dark:text-fg-dim">
                  <tr>
                    <th className="px-3 py-2 font-medium">Resource</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                  {[...data.projects.map((p) => ["Project", `/project/${encodeURIComponent(p.uuid)}`, p] as const), ...data.servers.map((s) => ["Server", `/server/${encodeURIComponent(s.uuid)}`, s] as const)].map(([kind, href, row]) => (
                    <tr key={`${kind}-${row.uuid}`} className="text-[13px] text-neutral-600 hover:bg-neutral-50 dark:text-fg-dim dark:hover:bg-white/[0.03]">
                      <td>
                        <a className="block px-3 py-2.5" href={href} target="_blank" rel="noopener noreferrer">
                          {kind}
                        </a>
                      </td>
                      <td>
                        <a className="block px-3 py-2.5 font-medium text-black dark:text-fg" href={href} target="_blank" rel="noopener noreferrer">
                          {row.name}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </SettingsSection>
      </div>
    </TeamLayout>
  );
}

export function TeamDangerPage() {
  return (
    <Layout title="Team" href="/team/danger" documentTitle="Team Danger Zone">
      <TeamDangerZone />
    </Layout>
  );
}
