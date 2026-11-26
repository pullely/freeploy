// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas-core.js (api, ApiError) (Apache-2.0), modified.
//
// The canvas's calls (DP-92): Coolify's canvases call its API controllers at /canvas/api with the
// browser session; Freeploy's call deploy-core-worker's canvas endpoints through api-edge with the
// console's session, in Freeploy's envelope ({ data } or { error: { message, details: { fields } } }).
// A failure throws CanvasApiError with Coolify's message: the API's message, then each field error.
import { edgeBase, sessionToken } from "./api";
import { canvasErrorMessage, type CanvasErrorBody as ErrorBody } from "./environment-canvas";

export class CanvasApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody | null,
  ) {
    super(canvasErrorMessage(status, body));
  }
}

/** api(method, path, body, { keepalive }): the answer's data, or a CanvasApiError. */
export async function canvasApi<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, options: { keepalive?: boolean } = {}): Promise<T> {
  const token = sessionToken();
  const response = await fetch(edgeBase() + path, {
    method,
    keepalive: !!options.keepalive,
    headers: {
      Accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Empty body.
  }
  if (!response.ok) throw new CanvasApiError(response.status, data as ErrorBody | null);
  return (data as { data?: T } | null)?.data as T;
}
