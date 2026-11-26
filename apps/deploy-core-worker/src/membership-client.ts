import type { AuthorizationContextResponse, MembershipFact } from "@saas/contracts/policy";

export type MembershipContextResult =
  | { ok: true; memberships: MembershipFact[] }
  | { ok: false; reason: string };

export async function fetchAuthorizationContext(
  membershipWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  orgId: string,
  requestId: string,
): Promise<MembershipContextResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/authorization-context",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          subject: { type: subjectType, id: subjectId },
          orgId,
        }),
      },
    );
  } catch {
    return { ok: false, reason: "membership_unreachable" };
  }

  if (!response.ok) {
    return { ok: false, reason: `membership_status_${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "membership_bad_body" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { ok: false, reason: "membership_bad_body" };
  }

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("memberships" in data)) {
    return { ok: false, reason: "membership_bad_body" };
  }

  const typed = data as AuthorizationContextResponse;
  if (!Array.isArray(typed.memberships)) {
    return { ok: false, reason: "membership_bad_body" };
  }

  return { ok: true, memberships: typed.memberships };
}

/**
 * The org as membership-worker shows it to the user (GET /v1/organizations/{org}): Coolify's team in /api/v1's
 * answers (DP-78; identity-worker's teams read it the same way, DP-70). Null when it is not shown.
 */
export async function fetchOrganizationFacts(
  membershipWorker: Fetcher,
  orgPublicId: string,
  subjectId: string,
  subjectType: string,
  requestId: string,
): Promise<{ id: string; name: string; createdAt: string } | null> {
  try {
    const res = await membershipWorker.fetch(`http://membership-worker/v1/organizations/${encodeURIComponent(orgPublicId)}`, {
      headers: { "x-request-id": requestId, "x-actor-subject-id": subjectId, "x-actor-subject-type": subjectType },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { organization?: { id?: unknown; name?: unknown; createdAt?: unknown } } };
    const org = body.data?.organization;
    if (!org || typeof org.id !== "string" || typeof org.name !== "string" || typeof org.createdAt !== "string") return null;
    return { id: org.id, name: org.name, createdAt: org.createdAt };
  } catch {
    return null;
  }
}
