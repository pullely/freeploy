// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/NodeIcon.svelte (Apache-2.0), modified.
// The logo of a resource card (database engine, service template, build source), or its type icon
// when it has no logo or the logo fails to load. The favicon of an application domain replaces the
// logo once it loads.
import { useState } from "react";
import type { CanvasNode } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";

export function NodeIcon({ node, className = "size-4" }: { node: CanvasNode; className?: string }) {
  const logo = node.logo ?? null;
  // Sources that failed to load; a failed logo shows its fallback, a failed fallback shows the type icon.
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  // The favicon URL that loaded.
  const [loadedFavicon, setLoadedFavicon] = useState<string | null>(null);
  const fail = (src: string) => setFailed((f) => ({ ...f, [src]: true }));
  const shown = (src: string) => (failed[src] && logo?.fallback ? logo.fallback : src);
  const broken = !!logo?.src && [logo.src, logo.dark].filter((s): s is string => !!s).some((src) => failed[src] && (!logo.fallback || failed[logo.fallback]));
  const favicon = logo?.favicon ?? null;
  if (favicon && loadedFavicon === favicon) return <img className="size-full object-contain p-1" alt="" src={favicon} />;
  const onError = (src: string) => () => fail(shown(src) === src ? src : (logo?.fallback ?? src));
  return (
    <>
      {!logo?.src || broken ? (
        <CanvasIcon name={node.type} className={className} />
      ) : (
        <span className="flex size-full items-center justify-center">
          <img className={`size-full object-contain ${logo.padded ? "p-1" : ""} ${logo.dark ? "dark:hidden" : ""}`} alt="" src={shown(logo.src)} onError={onError(logo.src)} />
          {logo.dark ? <img className={`size-full object-contain ${logo.padded ? "p-1" : ""} hidden dark:block`} alt="" src={shown(logo.dark)} onError={onError(logo.dark)} /> : null}
        </span>
      )}
      {favicon && !failed[favicon] ? <img className="hidden" alt="" src={favicon} onLoad={() => setLoadedFavicon(favicon)} onError={() => fail(favicon)} /> : null}
    </>
  );
}
