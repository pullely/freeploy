// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/Icon.svelte (Apache-2.0), modified.
//
// The app's reicon glyphs (Coolify clones them from the page's [data-deploy-canvas-icons] template; here
// they come from the generated paths), or a few local paths in the same style. The svg is the direct
// child that the canvas CSS expects.
import { REICON_PATHS } from "../../generated/reicon-paths";
import { LOCAL_ICONS } from "../../../lib/deploy-canvas";

export function Icon({ name, cls = "" }: { name: string; cls?: string }) {
  const glyph = REICON_PATHS[name];
  if (glyph) return <svg className={cls || undefined} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyph }} />;
  return (
    <svg className={cls || undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(LOCAL_ICONS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
