// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/new/select.blade.php
// (searchResources: sortFn, filterAndSort, filteredServices) (Apache-2.0), modified.
//
// The one-click services of the New Resource page: what GET …/deploy/services/templates answers, and
// Select's search and category filter over it. Pure functions, so that they can be tested without a page.

/** One service of Select::loadServices(), without its Compose file. */
export interface ServiceTemplate {
  id: string;
  name: string;
  docsSlug: string;
  templateLastUpdated: string | null;
  website: string | null;
  logo: string;
  logo_default_url: string;
  documentation: string;
  slogan: string;
  description?: string;
  category: string | null;
  amd_only?: boolean;
  arm_only?: boolean;
  outdated?: boolean;
}

export interface ServiceTemplates {
  services: ServiceTemplate[];
  categories: string[];
}

export const servicesApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/services`;
export const servicePath = (projectUuid: string, environmentUuid: string, serviceUuid: string) => `/project/${projectUuid}/environment/${environmentUuid}/service/${serviceUuid}`;

/** The service's uuid from /project/{uuid}/environment/{env_uuid}/service/{service_uuid}/…. */
export function serviceUuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[6] ?? "");
}

/** The type a service is created with, and back. */
export const ONE_CLICK_PREFIX = "one-click-service-";
export const oneClickType = (id: string) => `${ONE_CLICK_PREFIX}${id}`;
export const isOneClickType = (type: string | null): type is string => type !== null && type.startsWith(ONE_CLICK_PREFIX);

/**
 * filteredServices: the services whose name, description or slogan contains the search, sorted by name
 * (sortFn: localeCompare), then those of the selected category — a service's `category` may list several,
 * separated by commas; the comparison ignores case.
 */
export function filterServices(services: readonly ServiceTemplate[], search: string, selectedCategory: string): ServiceTemplate[] {
  const query = search.trim().toLowerCase();
  const matches = (value: string | undefined) => value !== undefined && value.toLowerCase().includes(query);
  let filtered = query === "" ? [...services] : services.filter((service) => matches(service.name) || matches(service.description) || matches(service.slogan));
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  if (selectedCategory === "") return filtered;
  const category = selectedCategory.toLowerCase();
  filtered = filtered.filter((service) =>
    String(service.category ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .includes(category),
  );
  return filtered;
}

/** The category filter's options: the categories that contain the search, ignoring case. */
export function filterCategories(categories: readonly string[], search: string): string[] {
  return search === "" ? [...categories] : categories.filter((category) => category.toLowerCase().includes(search.toLowerCase()));
}

/** The card's second line: "Updated Nov 16, 2026 07:50", or "Template ready" for a template without a date. */
export const templateStatus = (service: Pick<ServiceTemplate, "templateLastUpdated">): string => (service.templateLastUpdated ? `Updated ${service.templateLastUpdated}` : "Template ready");

/** The card's description. Coolify's fallback names its own templates; Freeploy's names none. */
export const templateDescription = (service: Pick<ServiceTemplate, "slogan" | "description">): string => service.slogan || service.description || "Deploy this service with a ready-to-use template.";
