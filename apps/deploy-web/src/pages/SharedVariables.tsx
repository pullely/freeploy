// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/shared-variables/index.blade.php,
// resources/views/livewire/shared-variables/{team/index,project/index,project/show,
// environment/index,environment/show,server/index,server/show}.blade.php (the page titles)
// and routes/web.php (shared-variables.*) (Apache-2.0), modified.
//
// The Shared Variables pages: one component per route, each inside the
// layout with Coolify's document title. Every one of them is under the
// breadcrumb "Shared Variables" and the sidebar's Shared Variables submenu.
import type { ReactNode } from "react";
import { Layout } from "../layout/Layout";
import type { PageKey } from "../routes";
import { EnvironmentVariablesIndex, ProjectVariablesIndex, ServerVariablesIndex, SharedVariablesOverview } from "./SharedVariableIndexes";
import { SharedVariablesEditor } from "./SharedVariablesEditor";

/** A path segment, decoded ("" when the path has none there). */
const segment = (index: number): string => decodeURIComponent(window.location.pathname.split("/")[index] ?? "");

/** The page of a route: its document title (<x-slot:title>) and its contents. */
function pageOf(page: PageKey): [string, ReactNode] | null {
  switch (page) {
    case "shared-variables.index":
      return ["Shared Variables", <SharedVariablesOverview key={page} />];
    case "shared-variables.team.index":
      return ["Team Variables", <SharedVariablesEditor key={page} scope={{ type: "team" }} />];
    case "shared-variables.project.index":
      return ["Project Variables", <ProjectVariablesIndex key={page} />];
    case "shared-variables.project.show":
      // /shared-variables/project/{project_uuid}
      return ["Project Variables", <SharedVariablesEditor key={page} scope={{ type: "project", uuid: segment(3) }} />];
    case "shared-variables.environment.index":
      return ["Environment Variables", <EnvironmentVariablesIndex key={page} />];
    case "shared-variables.environment.show":
      // /shared-variables/environments/project/{project_uuid}/environment/{environment_uuid}
      return ["Environment Variables", <SharedVariablesEditor key={page} scope={{ type: "environment", uuid: segment(6), projectUuid: segment(4) }} />];
    case "shared-variables.server.index":
      return ["Server Variables", <ServerVariablesIndex key={page} />];
    case "shared-variables.server.show":
      // /shared-variables/server/{server_uuid}
      return ["Server Variables", <SharedVariablesEditor key={page} scope={{ type: "server", uuid: segment(3) }} />];
    default:
      return null;
  }
}

export function SharedVariablesPage({ page }: { page: PageKey }) {
  const found = pageOf(page);
  if (!found) return null;
  const [documentTitle, contents] = found;
  return (
    <Layout title="Shared Variables" href="/shared-variables" documentTitle={documentTitle}>
      {contents}
    </Layout>
  );
}
