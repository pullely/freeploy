// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/database/configuration.blade.php,
// resources/views/livewire/project/shared/webhooks.blade.php (the branch for what is not an application)
// and routes/web.php (project.database.*) (Apache-2.0), modified.
//
// The pages of a standalone database that are Coolify's shared components
// with the database as their resource — configuration.blade.php renders
// <livewire:project.shared.environment-variable.all :resource="$database" />,
// <livewire:project.service.storage :resource="$database" />, and the shared
// tags, resource operations, resource limits, webhooks and danger
// components the same way. Each page here is the application's page with
// kind "database", inside the database's configuration frame:
//
//   /project/{uuid}/environment/{env_uuid}/database/{db_uuid}/environment-variables  project.database.environment-variables
//   …/persistent-storage   project.database.persistent-storage
//   …/tags                 project.database.tags
//   …/resource-operations  project.database.resource-operations
//   …/resource-limits      project.database.resource-limits
//   …/webhooks             project.database.webhooks
//   …/danger               project.database.danger
import type { ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { edgeBase } from "../lib/api";
import { SettingsSection } from "../components/Coolify";
import { useResourceSection, type DatabaseSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { EnvironmentVariablesContent } from "./ApplicationEnvironmentVariables";
import { StoragesContent } from "./ApplicationStorages";
import { TagsContent } from "./ApplicationTags";
import { ResourceOperationsContent } from "./ApplicationResourceOperations";
import { ResourceLimitsContent } from "./ApplicationResourceLimits";
import { DangerContent } from "./ApplicationDanger";
import { CopyInput } from "./ApplicationWebhooks";

/** Configuration's layout and title, as for every page of a database. */
const page = (content: ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    {content}
  </Layout>
);

export const DatabaseEnvironmentVariablesPage = () => page(<EnvironmentVariablesContent kind="database" />);
export const DatabaseStoragesPage = () => page(<StoragesContent kind="database" />);
export const DatabaseTagsPage = () => page(<TagsContent kind="database" />);
export const DatabaseResourceOperationsPage = () => page(<ResourceOperationsContent kind="database" />);
export const DatabaseResourceLimitsPage = () => page(<ResourceLimitsContent kind="database" />);
export const DatabaseDangerPage = () => page(<DangerContent kind="database" />);

/**
 * webhooks.blade.php for what is not an application: the deploy webhook only.
 * Its URL is Coolify's path on this environment's API origin. As on the
 * application's page, the Documentation link and the API-disabled callout are
 * not rendered.
 */
function DatabaseWebhooksContent() {
  const { me, data } = useResourceSection<DatabaseSectionData & { deployWebhookPath: string }>("database", "webhooks");
  if (!data) return null;
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Webhooks">
      <div className="application-settings-form">
        <SettingsSection title="Deploy webhook" helper="Trigger an external deployment with a valid Freeploy API authorization token.">
          <CopyInput label="Deploy webhook URL" text={edgeBase() + data.deployWebhookPath} />
        </SettingsSection>
      </div>
    </ResourceWorkspace>
  );
}

export const DatabaseWebhooksPage = () => page(<DatabaseWebhooksContent />);
