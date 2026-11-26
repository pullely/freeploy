// The subscription pages' decisions (DP-82, src/lib/subscription.ts): Subscription\Index's and Show's
// branches over billing-worker's summary, the plans sold, and the feature lists held to billing-worker's
// plan catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingDate,
  checkoutError,
  featureLines,
  formatPrice,
  indexState,
  PLAN_FEATURES,
  pricingPlans,
  PROVIDER_NOT_AVAILABLE,
  showState,
  type BillingSummary,
  type Plan,
} from "../src/lib/subscription.ts";
import { PLAN_CATALOG } from "../../billing-worker/src/plan-catalog.ts";

const plan = (code: string, priceAmountCents: number, billingInterval: Plan["billingInterval"] = "month"): Plan => ({
  id: `plan_${code}`,
  code,
  name: code[0]!.toUpperCase() + code.slice(1),
  description: null,
  status: "active",
  billingInterval,
  priceAmountCents,
  priceCurrency: "usd",
});

const summary = (code: string, status: "active" | "past_due" | "canceled" = "active"): BillingSummary => ({
  activeSubscription: { id: "sub_1", planId: `plan_${code}`, status, currentPeriodEnd: "2026-12-26T10:00:00.000Z", cancelAt: null, providerSubscriptionId: code === "free" ? null : "polar_sub" },
  plan: plan(code, code === "free" ? 0 : 2000),
  selfServe: { available: true, purchasablePlanCodes: ["pro", "business"] },
});

test("Index: who is not a billing admin sees Insufficient Permissions; a subscriber goes to /subscription", () => {
  assert.equal(indexState(null, null), "loading");
  assert.equal(indexState(404, null), "forbidden");
  assert.equal(indexState(503, null), "error");
  assert.equal(indexState(200, summary("free")), "pricing");
  assert.equal(indexState(200, { activeSubscription: null, plan: null }), "pricing");
  assert.equal(indexState(200, summary("pro")), "redirect-show");
  assert.equal(indexState(200, summary("pro", "past_due")), "unpaid");
  assert.equal(indexState(200, summary("pro", "canceled")), "pricing");
});

test("Show: who is not a billing admin goes to the dashboard, a team without a paid subscription to /subscription/new", () => {
  assert.equal(showState(null, null), "loading");
  assert.equal(showState(404, null), "redirect-dashboard");
  assert.equal(showState(200, summary("free")), "redirect-new");
  assert.equal(showState(200, summary("business")), "show");
  assert.equal(showState(200, summary("pro", "past_due")), "show");
});

test("the plans sold: priced, recurring and with a provider product, cheapest first", () => {
  const plans = [plan("business", 9900), plan("free", 0), plan("enterprise", 0, "none"), plan("pro", 2000)];
  assert.deepEqual(pricingPlans(plans, ["pro", "business", "enterprise", "free"]).map((p) => p.code), ["pro", "business"]);
  assert.deepEqual(pricingPlans(plans, ["business"]).map((p) => p.code), ["business"]);
  assert.deepEqual(pricingPlans(plans, []), []);
});

test("each sold plan's features are what billing-worker's catalog grants", () => {
  const sold = PLAN_CATALOG.filter((p) => p.billingInterval !== "none" && p.priceAmountCents > 0);
  assert.deepEqual(Object.keys(PLAN_FEATURES).sort(), sold.map((p) => p.code).sort());
  for (const p of sold) assert.deepEqual(PLAN_FEATURES[p.code], featureLines(p.entitlements), p.code);
});

test("prices, dates and messages as Coolify prints them", () => {
  assert.equal(formatPrice(500, "usd"), "$5");
  assert.equal(formatPrice(270, "usd"), "$2.70");
  assert.equal(formatPrice(2000, "eur"), "20 EUR");
  assert.equal(billingDate("2026-12-26T10:00:00.000Z"), "Dec 26, 2026");
  assert.equal(billingDate("2026-01-05T00:00:00.000Z"), "Jan 5, 2026");
  assert.equal(billingDate(null), null);
  assert.equal(checkoutError(400), "Price ID not found! Please contact the administrator.");
  assert.equal(checkoutError(502), "Unable to confirm checkout with Polar. Please try again shortly.");
  assert.equal(checkoutError(500), "Unable to start checkout. Please try again shortly.");
  assert.match(PROVIDER_NOT_AVAILABLE, /not available yet/);
});
