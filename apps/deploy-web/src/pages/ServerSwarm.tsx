// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/swarm.blade.php,
// config/deprecations.php (swarm) and app/Livewire/Server/Swarm.php (Apache-2.0), modified.
//
// /server/{uuid}/swarm: the legacy Docker Swarm roles. Only an org that
// already has a Swarm server can change them. The deprecation notice drops
// Coolify's v5 plans and its migration guide link.
import { Layout } from "../layout/Layout";
import { Callout, DeprecatedBadge, Listbox, SettingsSection } from "../components/Coolify";
import { limit, ServerWorkspace, useServerSection, yesNo } from "./ServerChrome";

interface Swarm {
  isSwarmManager: boolean;
  isSwarmWorker: boolean;
  canUseSwarm: boolean;
}

const title = (name: string) => `${limit(name, 10)} > Swarm | Freeploy`;

function ServerSwarmContent() {
  const { me, data, save } = useServerSection<Swarm>("swarm", title);
  if (!data) return null;
  const { server, settings, canUpdate } = data;
  /** instantSave() saves both roles. */
  const change = (patch: Partial<Swarm>) => void save({ isSwarmManager: settings.isSwarmManager, isSwarmWorker: settings.isSwarmWorker, ...patch }, true);

  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="swarm" canUpdate={canUpdate}>
      <div className="application-settings-form w-full">
        <SettingsSection id="server-swarm-section" title="Docker Swarm" helper="Legacy Docker Swarm role configuration for this server." actions={<DeprecatedBadge />}>
          <Callout title="Docker Swarm support is deprecated">
            Docker Swarm is deprecated and will be removed. Existing Swarm deployments will continue to work as-is. We do not recommend setting up new Swarm deployments for the time being.
          </Callout>

          {!settings.canUseSwarm ? (
            <Callout type="info" title="Unavailable for new teams" className="mt-4">
              Docker Swarm cannot be enabled because this team has no existing Swarm resources.
            </Callout>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Listbox
              id="isSwarmManager"
              label="Manager role"
              helper="Managers control scheduling and cluster state."
              options={[
                { value: "false", label: "Not a Swarm manager" },
                { value: "true", label: "Swarm manager" },
              ]}
              value={yesNo(settings.isSwarmManager)}
              onChange={(v) => change({ isSwarmManager: v === "true" })}
              disabled={!settings.canUseSwarm || settings.isSwarmWorker || !canUpdate}
            />
            <Listbox
              id="isSwarmWorker"
              label="Worker role"
              helper="Workers run tasks assigned by a Swarm manager."
              options={[
                { value: "false", label: "Not a Swarm worker" },
                { value: "true", label: "Swarm worker" },
              ]}
              value={yesNo(settings.isSwarmWorker)}
              onChange={(v) => change({ isSwarmWorker: v === "true" })}
              disabled={!settings.canUseSwarm || settings.isSwarmManager || !canUpdate}
            />
          </div>
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerSwarmPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Swarm">
      <ServerSwarmContent />
    </Layout>
  );
}
