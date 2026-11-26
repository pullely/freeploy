// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/CloneMe.php (selectServer) and
// resources/views/livewire/project/clone-me.blade.php (Apache-2.0), modified.
//
// What an environment's Clone page decides in the browser (DP-100): the selected server and destination, the counts
// under its tables and the clone buttons.

export interface CloneMeServer {
  uuid: string;
  name: string;
  destinations: Array<{ uuid: string; name: string }>;
}

export interface CloneMeResource {
  uuid: string;
  name: string;
  description: string | null;
}

export interface CloneMeData {
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  newName: string;
  servers: CloneMeServer[];
  applications: CloneMeResource[];
  databases: CloneMeResource[];
  services: CloneMeResource[];
}

export interface Selection {
  server: string | null;
  destination: string | null;
}

/** selectServer(): choosing the selected server and destination again clears the choice. */
export function selectServer(current: Selection, server: string, destination: string): Selection {
  if (server === current.server && destination === current.destination) return { server: null, destination: null };
  return { server, destination };
}

/** Str::plural($word, $count): the word for one, else its plural. */
export const plural = (word: string, count: number): string => (Math.abs(count) === 1 ? word : `${word}s`);

/** $servers->sum(fn ($server) => $server->destinations()->count()) */
export const destinationCount = (servers: readonly CloneMeServer[]): number => servers.reduce((n, s) => n + s.destinations.length, 0);

/** The applications, the databases and the services. */
export const resourceCount = (data: Pick<CloneMeData, "applications" | "databases" | "services">): number => data.applications.length + data.databases.length + data.services.length;

/** The two buttons: clone('environment') and clone('project'), in this order. */
export const CLONE_TYPES: ReadonlyArray<["environment" | "project", string]> = [
  ["environment", "Clone to environment"],
  ["project", "Clone to project"],
];

/** The Livewire payload of clone($type). */
export function cloneBody(type: "environment" | "project", newName: string, selection: Selection, cloneVolumeData: boolean) {
  return { type, newName, selectedDestination: selection.destination, cloneVolumeData };
}
