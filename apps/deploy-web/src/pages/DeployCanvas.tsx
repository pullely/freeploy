// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/deploy-canvas.blade.php and
// app/Livewire/DeployCanvas.php (Apache-2.0), modified.
//
// /canvas (deploy-canvas, DP-94): the full-bleed page that holds the deploy canvas
// (components/canvas/deploy), opened from an environment's New Resource page and its canvas
// (?project=…&environment=…). The page's data — whether projects and environments may be added, the
// one-click templates and their logos — comes from GET …/deploy/canvas, which, like every canvas
// endpoint, is a 404 for anyone without deploy.resource.write; the canvas then shows with no
// templates, and its lists show that error. Reset opens Coolify's confirmation.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { ModalConfirmation } from "../components/Coolify";
import { DeployCanvas } from "../components/canvas/deploy/DeployCanvas";
import { init, resetCanvas, type DeployCanvasPage } from "../components/canvas/deploy/state";

export const deployCanvasApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/canvas`;

function DeployCanvasContent() {
  const { me } = useSignedIn();
  const base = deployCanvasApi(me.team?.id);
  const [ready, setReady] = useState(false);
  const [resetRequest, setResetRequest] = useState(0);
  useEffect(() => {
    let live = true;
    void getJson<DeployCanvasPage>(base).then((r) => {
      if (!live) return;
      init(base, r.data);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [base]);
  if (!ready) return null;
  return (
    <div className="h-full">
      <div data-deploy-canvas="" className="relative h-full" data-team={me.team?.id ?? ""}>
        <DeployCanvas onAskReset={() => setResetRequest((n) => n + 1)} />
      </div>
      {/* Opened by the canvas Reset button. Out of the page flow, so the page does not scroll. */}
      <div className="absolute">
        <ModalConfirmation
          title="Reset the canvas?"
          trigger={<button type="button" className="hidden" aria-hidden="true"></button>}
          actions={["Remove every step from the canvas."]}
          confirmationText={null}
          warningMessage="Your steps and their settings are removed from the canvas. Resources that you already deployed stay in Freeploy."
          step2ButtonText="Reset"
          openRequest={resetRequest}
          onSubmit={async () => resetCanvas()}
        />
      </div>
    </div>
  );
}

export function DeployCanvasPage() {
  return (
    <Layout title="Deploy canvas" href="/canvas" fullBleed>
      <DeployCanvasContent />
    </Layout>
  );
}
