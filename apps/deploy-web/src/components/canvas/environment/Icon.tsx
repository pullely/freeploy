// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Icon.svelte (Apache-2.0), modified.
// Outline icon drawn from the local paths (environment-canvas.ts ICONS).
import { ICONS } from "../../../lib/environment-canvas";

export function CanvasIcon({ name, className = "size-3.5" }: { name: string; className?: string }) {
  return (
    <svg className={`${className} shrink-0`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(ICONS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
