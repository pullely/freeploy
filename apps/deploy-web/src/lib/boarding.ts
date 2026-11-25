// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Boarding/Index.php (Apache-2.0), modified.
//
// Boarding's steps (DP-75, pages/Boarding.tsx): Coolify's $currentState values, kept in the URL as
// `?step=` (#[Url(as: 'step', history: true)]), and what Freeploy answers for the steps it cannot do yet.

export type BoardingStep =
  | "welcome"
  | "explanation"
  | "select-server-type"
  | "private-key"
  | "create-private-key"
  | "create-server"
  | "validate-server"
  | "create-project"
  | "create-resource";

export const BOARDING_STEPS: readonly BoardingStep[] = ["welcome", "explanation", "select-server-type", "private-key", "create-private-key", "create-server", "validate-server", "create-project", "create-resource"];

/** The convention's words for what needs the SSH executor or a server Freeploy does not have. */
export const NOT_AVAILABLE = {
  localhost: "Deploying on this machine is not available yet: Freeploy does not run on a server of yours.",
  provider: "Provisioning a server with a cloud provider is not available yet.",
  validation: "Validating the server and installing Docker are not available yet: they need the SSH executor.",
} as const;

/** The step of the URL; a missing or unknown one is the welcome screen (Coolify's default 'welcome'). */
export function boardingStep(search: string): BoardingStep {
  const step = new URLSearchParams(search).get("step");
  return (BOARDING_STEPS as readonly string[]).includes(step ?? "") ? (step as BoardingStep) : "welcome";
}

/** The URL of a step: `?step=` beside the other query parameters, none for the welcome screen. */
export function boardingUrl(href: string, step: BoardingStep): string {
  const url = new URL(href);
  if (step === "welcome") url.searchParams.delete("step");
  else url.searchParams.set("step", step);
  return url.toString();
}
