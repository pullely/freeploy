// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/maintenance.blade.php,
// resources/views/livewire/project/application/swarm.blade.php, resources/views/livewire/project/application/
// configuration.blade.php, resources/views/livewire/select-team.blade.php, resources/views/components/auth/shell.blade.php,
// config/deprecations.php (swarm) and app/Livewire/{SelectTeam,Project/Application/Swarm,Project/Shared/Maintenance}.php
// (Apache-2.0), modified.
//
// DP-102's pages beside a service's Domains (ServiceDomains.tsx):
//
//   …/application/{uuid}/maintenance  project.application.maintenance  Maintenance with the application as its resource
//   …/service/{uuid}/maintenance      project.service.maintenance      the same component with the service
//   …/application/{uuid}/swarm        project.application.swarm        Swarm, rendered only for a Swarm server
//   /select-team                      team.select                      SelectTeam on Freeploy's org switching
//
// Turning maintenance mode on or off, or changing the page while it is on, writes the proxy's files on the server:
// the API answers that the SSH executor is not available yet and stores nothing. "Coolify default maintenance page"
// reads "Freeploy default", and the Swarm deprecation notice drops Coolify's v5 plans, as the server's Swarm page does.
import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { notify } from "../lib/toast";
import { clearSession, getJson, postJson, sessionToken, summarize } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DeprecatedBadge, FormInput, FormTextarea, Listbox, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { useApplicationSection, useResourceSection, yesNo, type ApplicationSectionData, type PatchError, type ResourceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { Toasts } from "../layout/Toasts";
import { maintenanceConfirmation, selectTeam, selectTeamMount, swarmDirty, swarmFormOf, teamInitial, type OrgSummary, type SwarmForm, type SwarmSettings } from "../lib/config-subpages";

/** Configuration's layout and title, as for every page of an application or a service. */
const page = (content: React.ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    {content}
  </Layout>
);

/** handleError(): the exception's message as an error toast (a ValidationException's summary). */
const errorToast = (error: PatchError) => notify.error(error.messages.length ? summarize(error.messages) : error.message);

// ---------------------------------------------------------------- Maintenance

interface Maintenance {
  isMaintenanceEnabled: boolean;
  maintenancePage: string | null;
  isSupported: boolean;
  maxKilobytes: number;
}

type MaintenanceData = ResourceSectionData & { maintenance: Maintenance };

/** <livewire:project.shared.maintenance :resource>: an application's or a service's maintenance mode. */
function MaintenanceContent({ kind }: { kind: "application" | "service" }) {
  const { me, data, setData, saving, patch } = useResourceSection<MaintenanceData>(kind, "maintenance");
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (data) setDraft(data.maintenance.maintenancePage ?? "");
  }, [data]);
  if (!data || draft === null) return null;
  const { canUpdate, maintenance } = data;
  const dirty = draft !== (maintenance.maintenancePage ?? "");
  const confirm = maintenanceConfirmation(maintenance.isMaintenanceEnabled);

  const run = async (body: Record<string, unknown>) => {
    const r = await patch<{ message: string; maintenance: Maintenance }>(body);
    if (!r.ok) return errorToast(r.error);
    setData({ ...data, maintenance: r.data.maintenance });
    notify.success(r.data.message);
  };
  const submit = () => void run({ action: "save", maintenancePage: draft });

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Maintenance Mode">
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          submit();
        }}
      >
        <UnsavedBar dirty={dirty} saving={saving} onSave={submit} />
        <SettingsSection
          id="maintenance-section"
          title="Maintenance mode"
          helper="Show a maintenance page with a 503 status on all domains of this resource. The containers keep running, and the change applies without a redeploy."
          badges={
            maintenance.isSupported ? (
              <span>{maintenance.isMaintenanceEnabled ? <StatusBadge label="On" type="success" /> : <StatusBadge label="Off" type="neutral" />}</span>
            ) : undefined
          }
          actions={
            maintenance.isSupported && canUpdate ? (
              <ModalConfirmation
                key={`maintenance-toggle-${maintenance.isMaintenanceEnabled ? "on" : "off"}`}
                title={confirm.title}
                trigger={
                  <button type="button" className={confirm.isErrorButton ? "button button-error" : "button"}>
                    {confirm.buttonTitle}
                  </button>
                }
                buttonTitle={confirm.buttonTitle}
                step2ButtonText={confirm.step2ButtonText}
                warningMessage={confirm.warningMessage}
                actions={confirm.actions}
                confirmationText={null}
                onSubmit={() => run({ action: "toggle" })}
              />
            ) : undefined
          }
        >
          {maintenance.isSupported ? (
            <div className="flex flex-col gap-4">
              <FormTextarea
                id="maintenancePage"
                rows={10}
                monospace
                label="Custom maintenance page (HTML)"
                placeholder="Leave empty to use the Freeploy default maintenance page."
                helper={`One self-contained HTML file (max ${maintenance.maxKilobytes} KB) with inline CSS and images.`}
                value={draft}
                onChange={setDraft}
                disabled={!canUpdate}
              />
              {canUpdate ? (
                <div className="flex gap-2">
                  <Button onClick={() => void run({ action: "reset" })}>Reset to default</Button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Maintenance mode needs a Traefik or Caddy proxy on a server that is not part of a Docker Swarm.</p>
          )}
        </SettingsSection>
      </form>
    </ResourceWorkspace>
  );
}

export const ApplicationMaintenancePage = () => page(<MaintenanceContent kind="application" />);
export const ServiceMaintenancePage = () => page(<MaintenanceContent kind="service" />);

// ---------------------------------------------------------------- Swarm

type SwarmData = ApplicationSectionData & { isSwarm: boolean; swarm: SwarmSettings | null };

/** configuration.blade.php: <livewire:project.application.swarm> only when the application's server is a Swarm one. */
function SwarmContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<SwarmData>("swarm");
  const [form, setForm] = useState<SwarmForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data?.swarm) setForm(swarmFormOf(data.swarm));
  }, [data]);
  if (!data) return null;
  const { canUpdate, swarm } = data;

  /** submit() and instantSave(): the whole form. */
  const save = async (next: SwarmForm) => {
    setErrors({});
    const r = await patch<{ message: string; swarm: SwarmSettings }>({ swarmReplicas: next.swarmReplicas, swarmPlacementConstraints: next.swarmPlacementConstraints === "" ? null : next.swarmPlacementConstraints, isSwarmOnlyWorkerNodes: next.isSwarmOnlyWorkerNodes });
    if (!r.ok) {
      setErrors(Object.fromEntries(Object.entries(r.error.fields).map(([k, v]) => [k, v[0] ?? ""])));
      return errorToast(r.error);
    }
    setData({ ...data, swarm: r.data.swarm });
    notify.success(r.data.message);
  };

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Swarm">
      {data.isSwarm && swarm && form ? (
        <form
          className="application-settings-form flex flex-col gap-6"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            void save(form);
          }}
        >
          <UnsavedBar dirty={swarmDirty(form, swarm)} saving={saving} onSave={() => void save(form)} />
          <SettingsSection title="Swarm configuration" helper="Legacy placement and replica settings for Docker Swarm deployments." actions={<DeprecatedBadge />}>
            <Callout title="Deprecated">Docker Swarm is deprecated and will be removed. Existing Swarm deployments will continue to work as-is. We do not recommend setting up new Swarm deployments for the time being.</Callout>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <FormInput id="swarmReplicas" label="Replicas" required value={form.swarmReplicas} onChange={(v) => setForm({ ...form, swarmReplicas: v })} disabled={!canUpdate} error={errors.swarmReplicas} />
              <Listbox
                id="isSwarmOnlyWorkerNodes"
                label="Node placement"
                options={[
                  { value: "true", label: "Worker nodes only" },
                  { value: "false", label: "Manager and worker nodes" },
                ]}
                value={yesNo(form.isSwarmOnlyWorkerNodes)}
                onChange={(v) => {
                  const next = { ...form, isSwarmOnlyWorkerNodes: v === "true" };
                  setForm(next);
                  void save(next);
                }}
                disabled={!canUpdate}
              />
              <div className="lg:col-span-2">
                <FormTextarea
                  id="swarmPlacementConstraints"
                  rows={8}
                  label="Custom placement constraints"
                  placeholder={"placement:\n    constraints:\n        - 'node.role == worker'"}
                  value={form.swarmPlacementConstraints}
                  onChange={(v) => setForm({ ...form, swarmPlacementConstraints: v })}
                  disabled={!canUpdate}
                  error={errors.swarmPlacementConstraints}
                />
              </div>
            </div>
          </SettingsSection>
        </form>
      ) : null}
    </ResourceWorkspace>
  );
}

export const ApplicationSwarmPage = () => page(<SwarmContent />);

// ---------------------------------------------------------------- /select-team

/**
 * /select-team (team.select): SelectTeam on Freeploy's org switching — the org a user works in is the one they last
 * picked (PATCH /v1/auth/profile { lastOrgSlug }, as accepting an invitation does), and the console falls back to
 * their first org. With a current org, or at most one org, the page goes to the dashboard.
 */
export function SelectTeamPage() {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  useEffect(() => {
    if (!sessionToken()) {
      window.location.replace("/login");
      return;
    }
    void (async () => {
      const session = await getJson<{ user: { lastOrgSlug?: string | null } }>("/v1/auth/session");
      if (!session.data) {
        if (session.status === 401) {
          clearSession();
          window.location.replace("/login");
        }
        return;
      }
      const list = (await getJson<{ organizations: OrgSummary[] }>("/v1/organizations")).data?.organizations ?? [];
      const mount = selectTeamMount(list, session.data.user.lastOrgSlug);
      if (mount.action === "redirect") {
        // refreshSession($resolved), then redirect()->route('dashboard').
        if (mount.store !== null) await postJson("/v1/auth/profile", { lastOrgSlug: mount.store }, "PATCH");
        window.location.replace("/");
        return;
      }
      setOrgs(list);
    })();
  }, []);

  async function pick(slug: string) {
    if (!orgs || selectTeam(orgs, slug) === null) return;
    const r = await postJson("/v1/auth/profile", { lastOrgSlug: slug }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/");
  }

  useEffect(() => {
    document.title = "Select a team | Freeploy";
  }, []);
  if (!orgs) return null;
  return (
    <>
      <main className="h-full bg-neutral-50 dark:bg-base">
        <section className="auth-shell application-settings-form">
          <div className="auth-shell-content">
            <div className="auth-card">
              <div className="auth-card-heading">
                <h1>Select a team</h1>
                <p>Choose the team you want to work in. Your choice is remembered for next time.</p>
              </div>
              <div className="auth-card-body">
                <div className="flex flex-col gap-2">
                  {orgs.map((team) => (
                    <button
                      key={team.slug}
                      type="button"
                      onClick={() => void pick(team.slug)}
                      className="group flex items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-white/[0.08] dark:hover:border-white/[0.16] dark:hover:bg-white/[0.04]"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-[13px] font-semibold text-neutral-600 dark:bg-white/[0.06] dark:text-fg">{teamInitial(team.name)}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-black dark:text-fg">{team.name}</span>
                      <Reicon name="arrow-right" className="size-4 shrink-0 text-neutral-400 dark:text-fg-faint" />
                    </button>
                  ))}
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
