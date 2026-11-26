// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/PaletteItem.svelte (Apache-2.0), modified.
//
// A step in the palette (drag it, or click to add it to the chain), or in
// the "Add the next step" menu (onPick).
import { TYPES, type StepType } from "../../../lib/deploy-canvas";
import { Icon } from "./Icon";
import { dragFromPalette } from "./state";

export function PaletteItem({ type, onPick = null }: { type: StepType; onPick?: (() => void) | null }) {
  const t = TYPES[type];
  return (
    <button type="button" className="cv-item" title={`${t.title} — ${t.sub}`} onClick={onPick ?? undefined} onPointerDown={onPick ? undefined : (e) => dragFromPalette(type, e)}>
      <i>
        <Icon name={t.icon} />
      </i>
      <span>
        <b>{t.title}</b>
        <small>{t.sub}</small>
      </span>
    </button>
  );
}
