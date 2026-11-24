// A Coolify route Freeploy has not ported yet. Like every route behind Laravel's
// auth middleware, a visitor without a session goes to /login; a signed-in user
// gets the layout and a plain notice instead of an empty page. The parity
// harness still reports the route as failing until its page is ported.
import { lazy, Suspense } from "react";
import { sessionToken } from "../lib/api";

const Layout = lazy(() => import("../layout/Layout").then((m) => ({ default: m.Layout })));

export function NotPortedPage() {
  if (!sessionToken()) {
    window.location.replace("/login");
    return null;
  }
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const title = path === "/" ? "Dashboard" : (path.split("/").filter(Boolean)[0] ?? "").replace(/^./, (c) => c.toUpperCase());
  return (
    <Suspense fallback={null}>
      <Layout title={title} href={path}>
        <div data-freeploy-not-ported="">
          <div className="mt-8 lg:mt-3">
            <div className="empty-state w-full">
              <div className="empty-state-well min-h-32">
                <h2 className="empty-state-title">This page is not available in Freeploy yet</h2>
                <p className="empty-state-description text-[12px]">It is being ported. Your profile and appearance settings are ready to use.</p>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    </Suspense>
  );
}
