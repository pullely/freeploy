// Derived from coollabsio/coolify@91b7e3e:app/Models/Application.php (previews), app/Models/ApplicationPreview.php
// ($casts), app/Livewire/Project/Application/{Previews,PreviewDomains}.php and
// app/Livewire/Project/Application/Preview/Form.php (the saves) (Apache-2.0), modified.
//
// The console's Preview Deployments page (DP-99): an application's previews as the page lists them, its two preview
// settings and its preview URL template, and a preview's DNS statuses. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployPreviewPageRow extends SqlRow {
  id: string | number;
  uuid: string;
  pull_request_id: number;
  pull_request_html_url: string;
  fqdn: string | null;
  status: string;
  git_type: string | null;
  docker_registry_image_tag: string | null;
  docker_compose_domains: string | null;
  domain_port_overrides: unknown;
  domain_dns_statuses: unknown;
  restart_count: number;
  max_restart_count: number;
  restart_limit_reached: boolean;
}

/** $application->previews: not soft-deleted, the newest pull request first. */
export async function listPreviewPageRows(tx: SqlExecutor, applicationId: string | number): Promise<DeployPreviewPageRow[]> {
  const r = await tx.execute<DeployPreviewPageRow>(
    `SELECT id, uuid, pull_request_id, pull_request_html_url, fqdn, status, git_type, docker_registry_image_tag, docker_compose_domains, domain_port_overrides,
            domain_dns_statuses, restart_count, max_restart_count, restart_limit_reached
       FROM deploy.application_previews WHERE application_id = $1 AND deleted_at IS NULL ORDER BY pull_request_id DESC, id`,
    [String(applicationId)],
  );
  return r.rows;
}

/** Previews::savePreviewSettings(): $application->settings' two preview switches. False when the settings row is not the org's. */
export async function updatePreviewDeploymentSettings(tx: SqlExecutor, applicationId: string | number, settings: { isPreviewDeploymentsEnabled: boolean; isPrDeploymentsPublicEnabled: boolean }): Promise<boolean> {
  const r = await tx.execute(
    `UPDATE deploy.application_settings SET is_preview_deployments_enabled = $2, is_pr_deployments_public_enabled = $3,
            updated_at = CASE WHEN is_preview_deployments_enabled IS DISTINCT FROM $2::boolean OR is_pr_deployments_public_enabled IS DISTINCT FROM $3::boolean THEN ${NOW} ELSE updated_at END
      WHERE application_id = $1 RETURNING id`,
    [applicationId, settings.isPreviewDeploymentsEnabled, settings.isPrDeploymentsPublicEnabled],
  );
  return r.rows.length > 0;
}

/** Preview\Form::submit() and resetToDefault(): $application->preview_url_template saved. */
export async function updateApplicationPreviewUrlTemplate(tx: SqlExecutor, applicationId: string | number, template: string): Promise<boolean> {
  const r = await tx.execute(
    `UPDATE deploy.applications SET preview_url_template = $2::text, updated_at = CASE WHEN preview_url_template::text IS DISTINCT FROM $2::text THEN ${NOW} ELSE updated_at END WHERE id = $1 RETURNING id`,
    [applicationId, template],
  );
  return r.rows.length > 0;
}

/** PreviewDomains::persistDnsStatuses(): the preview's domain_dns_statuses (null for none). */
export async function updatePreviewDnsStatuses(tx: SqlExecutor, previewId: string | number, statuses: Record<string, unknown> | null): Promise<void> {
  await tx.execute(`UPDATE deploy.application_previews SET domain_dns_statuses = $2::json, updated_at = ${NOW} WHERE id = $1`, [previewId, statuses === null ? null : JSON.stringify(statuses)]);
}
