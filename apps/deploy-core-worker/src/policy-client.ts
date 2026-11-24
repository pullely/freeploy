import type { AuthorizationRequest, AuthorizationResponse, PolicySubject, MembershipFact, PolicyResource } from "@saas/contracts/policy";

export interface AuthorizeResult {
  allow: boolean;
  /** Why a request was denied (policy's reason, or what failed on the way); for diagnostics only. */
  reason?: string;
}

export async function authorizeViaPolicy(
  policyWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  action: string,
  resource: PolicyResource,
  memberships: MembershipFact[],
  requestId: string,
): Promise<AuthorizeResult> {
  const subject: PolicySubject = {
    type: subjectType as PolicySubject["type"],
    id: subjectId,
  };

  const body: AuthorizationRequest = {
    subject,
    action,
    resource,
    context: { memberships },
  };

  let response: Response;
  try {
    response = await policyWorker.fetch(
      "http://policy-worker/v1/internal/policy/authorize",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return { allow: false, reason: "policy_unreachable" };
  }

  if (!response.ok) {
    return { allow: false, reason: `policy_status_${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { allow: false, reason: "policy_bad_body" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { allow: false, reason: "policy_bad_body" };
  }

  const data = (parsed as { data: unknown }).data;
  if (
    !data ||
    typeof data !== "object" ||
    !("allow" in data) ||
    typeof (data as AuthorizationResponse).allow !== "boolean"
  ) {
    return { allow: false, reason: "policy_bad_body" };
  }

  const decision = data as AuthorizationResponse & { reason?: unknown };
  return decision.allow ? { allow: true } : { allow: false, reason: typeof decision.reason === "string" ? decision.reason : "denied" };
}
