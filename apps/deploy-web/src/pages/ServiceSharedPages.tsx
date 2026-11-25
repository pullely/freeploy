// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/{configuration,storage}.blade.php
// and routes/web.php (project.service.*) (Apache-2.0), modified.
//
// The pages of a service that are Coolify's shared components with the service as their resource —
// configuration.blade.php renders <livewire:project.shared.environment-variable.all :resource="$service" />, the
// shared tags and danger components the same way, and for Persistent Storage one
// <livewire:project.service.storage :resource="…"> per application and database:
//
//   /project/{uuid}/environment/{env_uuid}/service/{service_uuid}/environment-variables  project.service.environment-variables
//   …/storages   project.service.storages
//   …/tags       project.service.tags
//   …/danger     project.service.danger
//
// Each is the application's page with kind "service", inside the service's frame; storage lists every part's
// volumes (read-only: the Compose file defines them), files and directories, under the service's directory.
import { useState, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { Empty, SettingsSection } from "../components/Coolify";
import { useResourceSection, type ServiceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { EnvironmentVariablesContent } from "./ApplicationEnvironmentVariables";
import { TagsContent } from "./ApplicationTags";
import { DangerContent } from "./ApplicationDanger";
import { defaultTab, FileStorage, TAB_ACTIVE, TAB_BASE, TAB_INACTIVE, VolumeList, type Mount, type Saved, type Send, type Storages, type Tab } from "./ApplicationStorages";
import { sendJson, showSaved } from "./ApplicationResource";
import { serviceApi } from "./ServiceChrome";

/** Configuration's layout and title, as for every page of a service. */
const page = (content: ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    {content}
  </Layout>
);

export const ServiceEnvironmentVariablesPage = () => page(<EnvironmentVariablesContent kind="service" />);
export const ServiceTagsPage = () => page(<TagsContent kind="service" />);
export const ServiceDangerPage = () => page(<DangerContent kind="service" />);

interface Section {
  kind: "application" | "database";
  uuid: string;
  name: string;
  title: string;
  storages: Storages;
}

/** storage.blade.php's service branch: one part's settings card and tables. */
function PartStorage({ section, canUpdate, base }: { section: Section; canUpdate: boolean; base: string }) {
  const [storages, setStorages] = useState(section.storages);
  const [tab, setTab] = useState<Tab | null>(null);
  const activeTab = tab ?? defaultTab(storages);
  const counts = { volumes: storages.volumes.length, files: storages.files.length, directories: storages.directories.length };
  const any = counts.volumes + counts.files + counts.directories > 0;
  const send: Send = async (method, path, body) => {
    const r = await sendJson<Saved>(method, `${base}/${encodeURIComponent(section.uuid)}${path}`, body);
    if (r.ok) {
      const { message, unavailable, ...rest } = r.data;
      setStorages({ ...storages, ...rest });
      showSaved({ message, ...(unavailable ? { unavailable } : {}) });
    }
    return r;
  };
  const tabButton = (name: Tab, label: string) => (
    <button type="button" onClick={() => setTab(name)} disabled={counts[name] === 0} className={`${TAB_BASE} ${activeTab === name ? TAB_ACTIVE : TAB_INACTIVE}`}>
      {label} ({counts[name]})
    </button>
  );
  const mounts = (list: Mount[], empty: ReactNode) => (
    <div className="flex flex-col gap-4 p-4">{list.length ? list.map((m) => <FileStorage key={m.id} mount={m} gitBased={false} canUpdate={canUpdate} send={send} />) : empty}</div>
  );
  return (
    <SettingsSection
      id={`storage-service-${section.uuid}`}
      title={section.title}
      flush
      helper="Volume mounts for this compose service. Compose-managed mounts are read-only in the dashboard."
      actions={
        any ? (
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-neutral-100 p-1 dark:bg-white/[0.04]">
            {tabButton("volumes", "Volumes")}
            {tabButton("files", "Files")}
            {tabButton("directories", "Directories")}
          </div>
        ) : null
      }
    >
      {!any ? (
        <Empty size="sm" title="No storage found" description="No volumes, files, or directories are defined for this service." iconName="storages" />
      ) : activeTab === "volumes" ? (
        counts.volumes ? (
          <VolumeList storages={storages} canUpdate={canUpdate} compose send={send} />
        ) : (
          <Empty size="sm" title="No volumes configured" description="This service has no volume mounts." iconName="storages" />
        )
      ) : activeTab === "files" ? (
        mounts(storages.files, <Empty size="sm" title="No file mounts configured" description="This service has no file mounts." iconName="file" />)
      ) : (
        mounts(storages.directories, <Empty size="sm" title="No directory mounts configured" description="This service has no directory mounts." iconName="folder" />)
      )}
    </SettingsSection>
  );
}

/** configuration.blade.php's storages branch. */
function ServiceStoragesContent() {
  const { me, data } = useResourceSection<ServiceSectionData & { sections: Section[] }>("service", "storages");
  if (!data) return null;
  const base = `${serviceApi(me.team?.id, data.service.uuid)}/storages`;
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Persistent Storage">
      <div className="space-y-6">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-5 text-amber-800 dark:border-warning/15 dark:bg-warning/[0.07] dark:text-amber-300/90">
          Service volume mounts are read-only here. Edit the Docker Compose file and reload it to change volumes.
        </div>
        {data.sections.map((section) => (
          <PartStorage key={section.uuid} section={section} canUpdate={data.canUpdate} base={base} />
        ))}
      </div>
    </ResourceWorkspace>
  );
}

export const ServiceStoragesPage = () => page(<ServiceStoragesContent />);
