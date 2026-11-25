// /project/{uuid}/environment/{env_uuid}/service/{service_uuid} (project.service.configuration): where
// creating a one-click service ends (DP-59). Freeploy's own first page of a service — its name and the
// applications and databases its Compose file was parsed into, from GET …/deploy/services/{uuid}.
// Coolify's service pages (the stack's configuration, each part's settings, environment variables,
// storages, logs, the deploy controls) are not ported yet; this page says so instead of imitating them.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { Callout, Empty, SettingsSection, StatusBadge } from "../components/Coolify";
import { Reicon } from "../components/Reicon";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectUuidFromPath } from "./ProjectChrome";
import { servicesApi, serviceUuidFromPath } from "../lib/service-templates";

interface Part {
  uuid: string;
  name: string;
  humanName: string | null;
  image: string | null;
  ports: string | null;
  status: string;
  fqdn: string | null;
  isRemovedFromCompose: boolean;
}

interface Service {
  uuid: string;
  name: string;
  description: string | null;
  serviceType: string | null;
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  applications: Part[];
  databases: Part[];
}

const ROW = "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left";
const ROW_ICON = "flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim";

function Parts({ title, helper, icon, parts }: { title: string; helper: string; icon: string; parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <SettingsSection title={title} helper={helper} flush>
      <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
        {parts.map((part) => (
          <div key={part.uuid} className={ROW}>
            <span className={ROW_ICON}>
              <Reicon name={icon} className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-black dark:text-fg">{part.humanName ?? part.name}</span>
              <span className="block truncate text-[11px] text-neutral-500 dark:text-fg-faint">{[part.image, part.fqdn, part.ports ? `Ports: ${part.ports}` : null].filter(Boolean).join(" · ")}</span>
            </span>
            <StatusBadge label={part.isRemovedFromCompose ? "Removed from the Compose file" : "Not deployed"} />
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function ServiceShowContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = serviceUuidFromPath();
  const [service, setService] = useState<Service | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ service: Service }>(`${servicesApi(me.team?.id)}/${encodeURIComponent(uuid)}`);
      if (!r.data) {
        // A service that is not the team's: back to the environment, as Coolify's pages redirect.
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      setService(r.data.service);
    })();
  }, [me.team?.id, uuid, projectUuid, environmentUuid]);
  useEffect(() => {
    if (service) document.title = `${limit(service.name, 10)} > Configuration | Freeploy`;
  }, [service]);

  if (!service) return null;
  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={service.project} environment={service.environment} />
      <div className="application-settings-form" data-freeploy-service-stub="">
        <SettingsSection title={service.name} helper={service.serviceType ? `Created from the ${service.serviceType} template.` : "A Docker Compose service."}>
          <Callout type="info" title="Created, not deployed">
            The service and everything its Compose file defines are stored: its applications, databases, generated environment variables and volumes. Configuring and deploying a service is not available in Freeploy yet.
          </Callout>
        </SettingsSection>
        <Parts title="Applications" helper="The parts of the service that are reached through a domain." icon="globe" parts={service.applications} />
        <Parts title="Databases" helper="The parts of the service that store its data." icon="database" parts={service.databases} />
        {service.applications.length + service.databases.length === 0 ? <Empty title="No parts" description="The Compose file of this service defines no services." iconName="layers" size="sm" /> : null}
      </div>
    </div>
  );
}

export function ServiceShowPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Service">
      <ServiceShowContent />
    </Layout>
  );
}
