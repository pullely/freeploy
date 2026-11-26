// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Subscription/{Index,Show,Actions,PricingPlans}.php (Apache-2.0), modified.
//
// The subscription pages' decisions over Freeploy's billing (DP-82), kept free of React so they are
// tested on their own. Coolify asks Stripe and its own subscriptions table; Freeploy asks billing-worker's
// GET /v1/organizations/{org}/billing/summary (the org's active subscription, its plan, and whether the
// environment's billing provider can sell) and GET …/billing/plans. Who may see them: Coolify's
// isAdminOfTeam (owner, admin) is Freeploy's billing.read / billing.manage (owner, billing_admin), which
// billing-worker enforces and answers with a 404 for anyone else.

/** The parts of GetBillingSummaryResponse (@saas/contracts/billing) the pages read. */
export interface BillingSummary {
  activeSubscription: {
    id: string;
    planId: string;
    status: "trialing" | "active" | "past_due" | "canceled" | "expired";
    currentPeriodEnd: string | null;
    cancelAt: string | null;
    providerSubscriptionId: string | null;
  } | null;
  plan: Plan | null;
  selfServe?: { available: boolean; purchasablePlanCodes: string[] };
}

/** The parts of PublicPlan the pages read. */
export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  billingInterval: "month" | "year" | "none";
  priceAmountCents: number | null;
  priceCurrency: string;
}

/** The plan every organization starts on (billing-worker's DEFAULT_PLAN_CODE). */
export const FREE_PLAN_CODE = "free";

/**
 * Coolify's `data_get(currentTeam(), 'subscription')`: whether the team has a subscription to manage —
 * in Freeploy, an active subscription on a paid plan (every org has one on Free, which is not one).
 */
export function hasSubscription(summary: BillingSummary): boolean {
  const sub = summary.activeSubscription;
  return sub !== null && summary.plan !== null && summary.plan.code !== FREE_PLAN_CODE && sub.status !== "canceled" && sub.status !== "expired";
}

/** Coolify's isSubscriptionActive(): subscribed and paid up (past_due is Stripe's unpaid). */
export function isSubscriptionActive(summary: BillingSummary): boolean {
  return hasSubscription(summary) && summary.activeSubscription?.status !== "past_due";
}

/**
 * Subscription\Index::mount() and getStripeStatus(), in the blade's order: not a team admin (the
 * summary answers 404) → the Insufficient Permissions section; an active subscription → /subscription;
 * an unpaid one → Payment failed; else the pricing (with "No active subscription" when none).
 */
export type IndexState = "loading" | "forbidden" | "redirect-show" | "unpaid" | "pricing" | "error";

export function indexState(status: number | null, summary: BillingSummary | null): IndexState {
  if (status === null) return "loading";
  if (status === 404 || status === 403) return "forbidden";
  if (!summary) return "error";
  if (isSubscriptionActive(summary)) return "redirect-show";
  if (hasSubscription(summary)) return "unpaid";
  return "pricing";
}

/**
 * Subscription\Show::mount(): a member goes to the dashboard (the summary answers 404), a team without a
 * subscription to /subscription/new; otherwise Actions renders.
 */
export type ShowState = "loading" | "redirect-dashboard" | "redirect-new" | "show" | "error";

export function showState(status: number | null, summary: BillingSummary | null): ShowState {
  if (status === null) return "loading";
  if (status === 404 || status === 403) return "redirect-dashboard";
  if (!summary) return "error";
  return hasSubscription(summary) ? "show" : "redirect-new";
}

/**
 * PricingPlans' plans: Coolify sells one (Pay as you go); Freeploy sells its catalog's priced, recurring
 * plans that the environment's provider has a product for, cheapest first. Free (every team's starting
 * plan) and Enterprise (contact sales) are not sold here.
 */
export function pricingPlans(plans: Plan[], purchasable: string[]): Plan[] {
  return plans
    .filter((p) => p.status === "active" && p.billingInterval !== "none" && (p.priceAmountCents ?? 0) > 0 && purchasable.includes(p.code))
    .sort((a, b) => (a.priceAmountCents ?? 0) - (b.priceAmountCents ?? 0));
}

/** The base price as Coolify prints it ("$5", "$2.70"): whole dollars without cents. */
export function formatPrice(cents: number, currency: string): string {
  const amount = cents / 100;
  const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency.toLowerCase() === "usd" ? `$${num}` : `${num} ${currency.toUpperCase()}`;
}

/** The interval under the price: "per month" / "per year". */
export function perInterval(interval: Plan["billingInterval"]): string {
  return interval === "year" ? "per year" : "per month";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Carbon's format('M j, Y') of the period end (UTC): "Nov 26, 2026". */
export function billingDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A plan entitlement as billing-worker's catalog defines it (PlanEntitlementDef). */
export interface EntitlementDef {
  entitlementKey: string;
  enabled: boolean;
  limitValue: number | null;
}

const count = (n: number | null, one: string, many: string) => (n === null ? `Unlimited ${many}` : `Up to ${n} ${n === 1 ? one : many}`);

/**
 * PricingPlans' feature list for a Freeploy plan: what its entitlements grant, in the catalog's words.
 * Coolify lists its one plan's features by hand; Freeploy's follow billing-worker's plan catalog.
 */
export function featureLines(entitlements: EntitlementDef[]): string[] {
  const get = (key: string) => entitlements.find((e) => e.entitlementKey === key);
  const lines: string[] = [];
  const projects = get("limit.projects");
  if (projects?.enabled) lines.push(count(projects.limitValue, "project", "projects"));
  const environments = get("limit.environments");
  if (environments?.enabled) lines.push(count(environments.limitValue, "environment", "environments"));
  const members = get("limit.members");
  if (members?.enabled) lines.push(count(members.limitValue, "team member", "team members"));
  if (get("feature.custom_domains")?.enabled) lines.push("Custom domains");
  const orgs = get("limit.organizations");
  if (get("feature.multi_org")?.enabled && orgs?.enabled) lines.push(orgs.limitValue === null ? "Unlimited teams" : `Up to ${orgs.limitValue} teams`);
  return lines;
}

/**
 * The feature lists of the plans sold, as featureLines() reads billing-worker's PLAN_CATALOG
 * (apps/billing-worker/src/plan-catalog.ts; test/subscription.test.ts holds the two together).
 */
export const PLAN_FEATURES: Record<string, string[]> = {
  pro: ["Up to 25 projects", "Up to 3 environments", "Up to 20 team members", "Custom domains"],
  business: ["Up to 100 projects", "Up to 5 environments", "Up to 50 team members", "Custom domains", "Up to 5 teams"],
};

/**
 * PricingPlans::subscribeStripe()'s messages for checkout's answers: 400 is billing-worker's
 * plan_not_purchasable (no provider product: Coolify's missing price id), 502 the provider's error
 * (Coolify's ApiErrorException, Polar for Stripe), anything else Coolify's RuntimeException.
 */
export function checkoutError(status: number): string {
  if (status === 400) return "Price ID not found! Please contact the administrator.";
  if (status === 502) return "Unable to confirm checkout with Polar. Please try again shortly.";
  return "Unable to start checkout. Please try again shortly.";
}

/** Shown, as the convention says, where the environment has no billing provider configured. */
export const PROVIDER_NOT_AVAILABLE = "Self-serve billing is not available yet: no billing provider is configured for this environment.";
