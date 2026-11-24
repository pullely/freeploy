// Derived from coollabsio/coolify@91b7e3e:resources/views/components/security/settings-layout.blade.php
// (Apache-2.0), modified.
//
// <x-security.settings-layout>: what the Keys & Tokens pages share. Their menu
// is the Keys & Tokens submenu of the main sidebar; this is the mobile title,
// the pages fed to the page search, and the row of page actions.
import type { ReactNode } from "react";

/** The Keys & Tokens pages, as settingsSearchItems() feeds them to the page search. */
function searchItems(): string {
  const origin = window.location.origin;
  const pages: Array<[string, string]> = [
    ["Private Keys", "/security/private-key"],
    ["API Tokens", "/security/api-tokens"],
    ["Cloud Tokens", "/security/cloud-tokens"],
    ["Integration Tokens", "/security/integration-tokens"],
    ["Cloud-Init Scripts", "/security/cloud-init-scripts"],
  ];
  return JSON.stringify(pages.map(([label, path]) => ({ label, breadcrumb: "Keys & Tokens", search_text: `${label} Keys & Tokens`, href: origin + path, navigate: true })));
}

export function SecurityLayout({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="w-full max-w-none">
      <header className="settings-mobile-header xl:hidden">
        <h1 className="settings-mobile-title">Keys & Tokens</h1>
        <p className="settings-mobile-description">Manage SSH keys, cloud credentials, and API access tokens.</p>
      </header>
      <div hidden data-settings-search-items={searchItems()} />
      <div className="min-w-0">
        {actions ? <div className="mb-3 flex min-h-8 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        {children}
      </div>
    </section>
  );
}

/** Carbon's format('Y-m-d H:i') of a UTC instant. */
export function formatCreated(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

/** A failed save: the errors under the form's own fields, anything else as Coolify's error toast. */
export function fieldErrors(fields: Record<string, string[]> | undefined, names: string[]): Record<string, string> {
  const inline: Record<string, string> = {};
  for (const name of names) {
    const message = fields?.[name]?.[0];
    if (message) inline[name] = message;
  }
  return inline;
}
