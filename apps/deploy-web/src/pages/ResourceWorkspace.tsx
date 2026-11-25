// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/configuration.blade.php and
// resources/views/livewire/project/database/configuration.blade.php (Apache-2.0), modified.
//
// The configuration frame of a page Coolify shares between an application and
// a standalone database (the same Livewire component inside either
// configuration view): the application's heading and menu, or the
// database's.
import type { ReactNode } from "react";
import { ApplicationWorkspace } from "./ApplicationChrome";
import { DatabaseWorkspace } from "./DatabaseChrome";
import type { ResourceSectionData } from "./ApplicationSection";

export function ResourceWorkspace({ data, orgId, active, children }: { data: ResourceSectionData; orgId: string | undefined; active: string; children: ReactNode }) {
  if ("application" in data) {
    return (
      <ApplicationWorkspace application={data.application} orgId={orgId} active={active} canUpdate={data.canUpdate} canDeploy={data.canDeploy}>
        {children}
      </ApplicationWorkspace>
    );
  }
  return (
    <DatabaseWorkspace database={data.database} orgId={orgId} active={active} canUpdate={data.canUpdate} canManage={data.canManage}>
      {children}
    </DatabaseWorkspace>
  );
}
