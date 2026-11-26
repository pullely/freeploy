import type { Env } from "./env.js";
import type { BillingSelfServe } from "@saas/contracts/billing";
import { resolveProviderId } from "./billing-provider/registry.js";
import { parsePolarConfig } from "./billing-provider/polar-mapping.js";
import { getPlanDefinition } from "./plan-catalog.js";

/**
 * What the console's subscription pages may offer in this environment (DP-82):
 * whether the env-selected provider has an adapter that the registry would
 * resolve (`buildBillingProviderRegistry` registers Polar only when its access
 * token and webhook secret are set; Stripe has no adapter yet), and which plans
 * it can sell — the product map's codes that name a priced, recurring catalog
 * plan (the same plans checkout accepts). Reads only env; no provider call.
 */
export function selfServeBilling(env: Env): BillingSelfServe {
  const config = resolveProviderId(env) === "polar" ? parsePolarConfig(env) : null;
  if (!config) return { available: false, purchasablePlanCodes: [] };
  const purchasablePlanCodes = Object.keys(config.productMap).filter((code) => {
    const plan = getPlanDefinition(code);
    return plan !== null && plan.billingInterval !== "none" && plan.priceAmountCents > 0;
  });
  return { available: true, purchasablePlanCodes };
}
