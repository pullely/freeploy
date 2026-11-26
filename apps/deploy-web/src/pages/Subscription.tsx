// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/subscription/{index,show,actions,pricing-plans}.blade.php,
// resources/views/components/skeleton/settings-sections.blade.php and
// app/Livewire/Subscription/{Index,Show,Actions,PricingPlans}.php (Apache-2.0), modified.
//
// /subscription/new (Subscription\Index with PricingPlans) and /subscription (Subscription\Show with
// Actions), DP-82: Coolify Cloud's pages over Freeploy's billing — billing-worker through api-edge's
// billing facade (GET …/billing/summary and …/billing/plans; POST …/billing/checkout, …/billing/portal
// and …/billing/subscription/cancel). Coolify renders them only on Cloud; Freeploy is its own cloud.
//
// Who: billing-worker's billing.read / billing.manage (owner and billing_admin), Coolify's isAdminOfTeam
// (owner and admin); anyone else gets a 404 from the summary — Index's Insufficient Permissions section,
// Show's redirect to the dashboard.
//
// Freeploy's provider is Polar, not Stripe, and its plans are the catalog's (Pro, Business — monthly),
// not Coolify's pay-as-you-go per server: the pricing lists each plan the provider sells, and there is
// no Monthly/Yearly switch, no server limit to adjust, no refunds and no immediate cancellation (Polar
// cancels at the end of the period; Freeploy moves the team to Free when the cancellation is recorded).
// Without a configured provider (summary.selfServe.available false) the pages say so and offer nothing
// that would fail. "Contact us" / "Need help?" are not ported (no contact page).
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerCallout, DashboardTitle, ModalConfirmation, SettingsSection, StatusBadge } from "../components/Coolify";
import {
  billingDate,
  checkoutError,
  formatPrice,
  indexState,
  perInterval,
  PLAN_FEATURES,
  pricingPlans,
  PROVIDER_NOT_AVAILABLE,
  showState,
  type BillingSummary,
  type Plan,
} from "../lib/subscription";

const billingApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/billing`;

/** The summary as both pages read it: its status (404 for who is not a billing admin) and body. */
function useSummary(): { status: number | null; summary: BillingSummary | null; base: string } {
  const { me } = useSignedIn();
  const base = billingApi(me.team?.id);
  const [state, setState] = useState<{ status: number | null; summary: BillingSummary | null }>({ status: null, summary: null });
  useEffect(() => {
    void getJson<BillingSummary>(`${base}/summary`).then((r) => setState({ status: r.status, summary: r.data }));
  }, [base]);
  return { ...state, base };
}

/** Index::stripeCustomerPortal() / Actions::stripeCustomerPortal(): the provider's hosted portal. */
async function openPortal(base: string) {
  const r = await postJson<{ portalUrl: string }>(`${base}/portal`, {});
  if (!r.ok) return notify.error(r.error.status === 503 ? PROVIDER_NOT_AVAILABLE : "Could not open the billing portal. Please try again shortly.");
  window.location.assign(r.data.portalUrl);
}

/** <x-skeleton.settings-sections :count="2">. */
function SkeletonSections({ count = 2, label }: { count?: number; label: string }) {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <section key={i} className="application-settings-section" aria-hidden="true">
          <header>
            <div aria-hidden="true" className={`animate-pulse bg-neutral-200/80 dark:bg-white/[0.06] my-1 h-3 ${i % 2 === 0 ? "w-40" : "w-28"} rounded-full`} />
            <div aria-hidden="true" className="animate-pulse bg-neutral-200/80 dark:bg-white/[0.06] h-7 w-20 rounded-lg" />
          </header>
          <div className="application-settings-section-body">
            <div aria-hidden="true" className="animate-pulse bg-neutral-200/80 dark:bg-white/[0.06] h-40 w-full rounded-lg" />
          </div>
        </section>
      ))}
    </div>
  );
}

/** livewire:subscription.pricing-plans: one section per plan Freeploy sells. */
function PricingPlans({ base, selfServe }: { base: string; selfServe: { available: boolean; purchasablePlanCodes: string[] } }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void getJson<{ plans: Plan[] }>(`${base}/plans?status=active`).then((r) => setPlans(r.data?.plans ?? []));
  }, [base]);

  /** subscribeStripe($type): a hosted checkout, or the portal when the team already subscribes. */
  async function subscribe(planCode: string) {
    setBusy(planCode);
    const r = await postJson<{ checkoutUrl: string; mode?: "checkout" | "portal" }>(`${base}/checkout`, { planCode, embedOrigin: window.location.origin, returnPath: "/subscription" });
    if (!r.ok) {
      setBusy(null);
      return notify.error(r.error.status === 503 ? PROVIDER_NOT_AVAILABLE : checkoutError(r.error.status));
    }
    window.location.assign(r.data.checkoutUrl);
  }

  if (!selfServe.available) {
    return (
      <Callout type="warning" title="Not available yet">
        {PROVIDER_NOT_AVAILABLE}
      </Callout>
    );
  }
  if (plans === null) return <SkeletonSections label="Loading plans" />;
  const sold = pricingPlans(plans, selfServe.purchasablePlanCodes);
  if (sold.length === 0) {
    return (
      <Callout type="warning" title="Not available yet">
        No plan can be bought through self-serve checkout in this environment.
      </Callout>
    );
  }
  return (
    <div className="w-full flex flex-col gap-6">
      {sold.map((plan) => (
        <SettingsSection key={plan.code} title={plan.name} {...(plan.description ? { helper: plan.description } : {})}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
            <div className="rounded-[10px] border border-neutral-200 bg-neutral-50 p-4 dark:border-white/[0.08] dark:bg-white/[0.05]">
              <p className="text-[11px] font-medium text-neutral-500 dark:text-fg-faint">Base price</p>
              <div className="mt-2 flex items-end gap-1.5">
                <span className="text-2xl font-semibold tracking-tight">{formatPrice(plan.priceAmountCents ?? 0, plan.priceCurrency)}</span>
                <span className="pb-0.5 text-[12px] text-neutral-500 dark:text-fg-dim">{perInterval(plan.billingInterval)}</span>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">{plan.billingInterval === "year" ? "Billed annually." : "Billed monthly."}</p>
              <div className="mt-4">
                <Button className="w-full justify-center" highlighted disabled={busy !== null} onClick={() => void subscribe(plan.code)}>
                  {plan.billingInterval === "year" ? "Subscribe yearly" : "Subscribe monthly"}
                </Button>
              </div>
            </div>

            <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
              {(PLAN_FEATURES[plan.code] ?? []).map((feature) => (
                <div key={feature} className="flex min-h-10 items-center gap-2.5 py-2 text-[12px]">
                  <Reicon name="check-circle" className="size-4 shrink-0 text-emerald-500" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-5 text-[11px] leading-5 text-neutral-500 dark:text-fg-faint">Bring your own servers from any cloud provider or supported Linux machine. Prices exclude applicable taxes.</p>
        </SettingsSection>
      ))}
    </div>
  );
}

/** livewire/subscription/index.blade.php. */
function SubscriptionIndex() {
  const { status, summary, base } = useSummary();
  const state = indexState(status, summary);
  useEffect(() => {
    if (state === "redirect-show") window.location.replace("/subscription");
  }, [state]);
  const selfServe = summary?.selfServe ?? { available: false, purchasablePlanCodes: [] };
  return (
    <div className="application-settings-form w-full max-w-none">
      <DashboardTitle title="Subscription" subtitle="Choose a plan for Freeploy" />
      {state === "forbidden" ? (
        <SettingsSection title="Subscription" helper="Only team administrators can manage billing and plan limits.">
          <DangerCallout title="Insufficient Permissions" className="">
            You are not an admin so you cannot manage your Team's subscription.
          </DangerCallout>
        </SettingsSection>
      ) : state === "loading" || state === "redirect-show" ? (
        <SkeletonSections label="Loading your subscription status" />
      ) : state === "error" ? (
        <DangerCallout title="Error" className="">
          Could not retrieve subscription information. Please try again later.
        </DangerCallout>
      ) : state === "unpaid" ? (
        <SettingsSection title="Payment failed" helper="Your latest Freeploy payment could not be processed.">
          <DangerCallout title="Subscription payment is past due" className="">
            Update the payment method or settle the outstanding invoice in the billing portal.
          </DangerCallout>
          <div className="mt-4">
            {selfServe.available ? (
              <Button highlighted onClick={() => void openPortal(base)}>
                Open billing portal
              </Button>
            ) : (
              <Callout type="warning" title="Not available yet">
                {PROVIDER_NOT_AVAILABLE}
              </Callout>
            )}
          </div>
        </SettingsSection>
      ) : (
        <>
          <Callout type="warning" title="No active subscription" className="mb-6">
            Your team is on the {summary?.plan?.name ?? "Free"} plan. Choose a plan to raise its limits.
          </Callout>
          <PricingPlans base={base} selfServe={selfServe} />
        </>
      )}
    </div>
  );
}

/** livewire/subscription/actions.blade.php, Polar's branch (Coolify's `subscriptionProvider() === 'stripe'`). */
function SubscriptionActions({ summary, base }: { summary: BillingSummary; base: string }) {
  const { me } = useSignedIn();
  const sub = summary.activeSubscription!;
  const plan = summary.plan!;
  const selfServe = summary.selfServe ?? { available: false, purchasablePlanCodes: [] };
  const cancelling = sub.cancelAt !== null;
  const nextBillingDate = billingDate(cancelling ? sub.cancelAt : sub.currentPeriodEnd);
  const teamName = me.team?.name ?? "";

  /** cancelAtPeriodEnd(): billing-worker asks Polar, which cancels at the end of the period. */
  async function cancelAtPeriodEnd() {
    const r = await postJson<{ cancelAtPeriodEnd: boolean }>(`${base}/subscription/cancel`, {});
    if (!r.ok) return notify.error(r.error.status === 503 ? PROVIDER_NOT_AVAILABLE : "Something went wrong with the cancellation.");
    notify.success(r.data.cancelAtPeriodEnd ? "Subscription will be cancelled at the end of the billing period." : "Subscription cancelled successfully.");
    window.location.assign("/subscription");
  }

  return (
    <div className="application-settings-workspace flex flex-col gap-6">
      <SettingsSection title="Plan and billing">
        <div className="flex flex-col gap-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg! font-semibold!">{plan.name}</h2>
              <span className="text-sm text-neutral-500">{plan.billingInterval === "year" ? "Yearly" : "Monthly"} billing</span>
              {cancelling ? <StatusBadge type="warning" label="Cancelling at end of period" /> : <StatusBadge type="success" label="Active" />}
            </div>
            {nextBillingDate ? (
              <div className="text-sm flex items-center gap-2 flex-wrap">
                <span className="text-neutral-500">
                  {cancelling ? "Cancels on " : "Next billing "}
                  <span className="dark:text-white font-medium">{nextBillingDate}</span>
                </span>
              </div>
            ) : null}
          </div>

          {selfServe.available ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button className="gap-2" onClick={() => void openPortal(base)}>
                <Reicon name="subscription" className="size-3.5" />
                Open billing portal
              </Button>
            </div>
          ) : (
            <Callout type="warning" title="Not available yet">
              {PROVIDER_NOT_AVAILABLE}
            </Callout>
          )}
        </div>
      </SettingsSection>

      {selfServe.available ? (
        <SettingsSection title="Manage subscription">
          <section aria-labelledby="subscription-cancellation" className="flex flex-col gap-3">
            <div className="space-y-1">
              <h3 id="subscription-cancellation" className="text-sm! font-medium!">
                Cancel subscription
              </h3>
              <p className="text-sm text-neutral-500">Keep access until the end of your billing period.</p>
            </div>
            {cancelling ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <ModalConfirmation
                  title="Cancel at End of Billing Period?"
                  buttonTitle="Cancel at Period End"
                  actions={[
                    "Your subscription will remain active at Polar until the end of the current billing period.",
                    "No further charges will be made after the current period.",
                    "You can resubscribe at any time.",
                  ]}
                  confirmationText={teamName}
                  confirmationLabel="Enter your team name to confirm"
                  shortConfirmationLabel="Team Name"
                  step2ButtonText="Confirm Cancellation"
                  onSubmit={cancelAtPeriodEnd}
                />
              </div>
            )}
            {cancelling ? <p className="text-sm text-neutral-500">Your subscription is set to cancel at the end of the billing period.</p> : null}
          </section>
        </SettingsSection>
      ) : null}
    </div>
  );
}

/** livewire/subscription/show.blade.php. */
function SubscriptionShow() {
  const { status, summary, base } = useSummary();
  const state = showState(status, summary);
  useEffect(() => {
    if (state === "redirect-dashboard") window.location.replace("/");
    if (state === "redirect-new") window.location.replace("/subscription/new");
  }, [state]);
  return (
    <div className="application-settings-form w-full max-w-none">
      <DashboardTitle title="Subscription" subtitle="Plan and billing for Freeploy" />
      {state === "show" && summary ? (
        <SubscriptionActions summary={summary} base={base} />
      ) : state === "error" ? (
        <DangerCallout title="Error" className="">
          Could not retrieve subscription information. Please try again later.
        </DangerCallout>
      ) : (
        <SkeletonSections label="Loading your subscription" />
      )}
    </div>
  );
}

export function SubscriptionNewPage() {
  return (
    <Layout title="Subscription" href="/subscription/new" documentTitle="Subscribe">
      <SubscriptionIndex />
    </Layout>
  );
}

export function SubscriptionPage() {
  return (
    <Layout title="Subscription" href="/subscription">
      <SubscriptionShow />
    </Layout>
  );
}
