// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/StatusDot.svelte (Apache-2.0), modified.
import { statusLabel, statusTone, TONE_DOT } from "../../../lib/environment-canvas";

export function StatusDot({ status, size = "size-2", title = null }: { status: string | null | undefined; size?: string; title?: string | null }) {
  const tone = statusTone(status);
  return (
    <span className={`relative flex ${size} shrink-0`} title={title || statusLabel(status)}>
      {tone === "busy" ? <span className={`absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping ${TONE_DOT.busy}`}></span> : null}
      <span className={`relative inline-flex size-full rounded-full ${TONE_DOT[tone]}`}></span>
    </span>
  );
}
