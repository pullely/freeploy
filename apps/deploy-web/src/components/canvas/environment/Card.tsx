// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Card.svelte (Apache-2.0), modified.
// A resource card. Not ported: the connect view's shared variable and tag cards, the dashboard's
// deployment pill and the drag dot that draws a link (Freeploy saves no links yet).
import type { PointerEvent as ReactPointerEvent } from "react";
import { isSource, MAX_CHILDREN, statusLabel, statusTone, statusWord, TYPE_LABELS, type CanvasNode, type Point, type Tone } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";
import { NodeIcon } from "./NodeIcon";
import { StatusDot } from "./StatusDot";

const CHIP =
  "inline-flex h-5 max-w-[9rem] items-center truncate rounded-full border border-neutral-200 bg-neutral-50 px-1.5 text-[10px] font-medium text-neutral-500 dark:border-white/[0.1] dark:bg-white/[0.05] dark:text-fg-dim";
// Same as the deploy canvas drop target: accent border and a soft 4px ring.
const DROP_TARGET = "border-coollabs! dark:border-warning! ring-4 ring-coollabs/15 dark:ring-warning/15";
// The server is not reachable, so the saved status is stale: show it as unknown, not as a failure.
const DOWN = "Unknown (server not reachable)";
const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-warning-700 dark:text-warning",
  busy: "text-warning-700 dark:text-warning",
  bad: "text-red-600 dark:text-red-400",
  idle: "text-neutral-500 dark:text-fg-faint",
};
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function Card(props: {
  node: CanvasNode;
  position: Point | undefined;
  selected: boolean;
  dropTarget?: boolean;
  movable: boolean;
  zoneNames: string[];
  serverDown?: boolean;
  statusText?: boolean;
  onPress: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const { node, position, serverDown = false } = props;
  const extra = node.extra_zones?.length || 0;
  const security = node.security?.text ? node.security : null;
  const children = node.children ?? [];
  const status = serverDown ? "unknown" : node.status;
  const border = props.selected
    ? "border-coollabs ring-2 ring-coollabs/25 dark:border-warning dark:ring-warning/25"
    : node.missing
      ? "border-dashed border-red-300 dark:border-red-500/40"
      : "border-neutral-200 hover:border-neutral-300 dark:border-white/[0.08] dark:hover:border-white/[0.16]";
  return (
    // data-ec-open: its page opens on double-click (see the root's pointerdown capture listener).
    <div
      className={`group absolute flex w-[260px] flex-col rounded-xl border bg-white p-3 shadow-sm transition-shadow hover:shadow-md dark:bg-raised ${border} ${props.movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${props.dropTarget ? DROP_TARGET : ""}`}
      style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}
      data-ec-card=""
      data-id={node.id}
      data-ec-open={node.link || undefined}
      title={node.link ? "Double-click to open" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${node.name} (${TYPE_LABELS[node.type] || node.type}), ${serverDown ? DOWN : statusLabel(node.status)}`}
      onPointerDown={props.onPress}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelect();
        }
      }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border ${
            node.missing
              ? "border-red-200 bg-red-50 text-red-500 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
              : "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim"
          }`}
        >
          <NodeIcon node={node} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[13px] leading-4 font-semibold text-black dark:text-fg ${node.type === "variable" ? "font-mono" : ""} ${node.link ? "underline-offset-2 group-hover:underline" : ""}`}>{node.name}</div>
          <div className="mt-0.5 truncate text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">{node.subtitle || TYPE_LABELS[node.type] || ""}</div>
        </div>
        {isSource(node) ? null : props.statusText ? (
          // Server view: the status in words, so a stopped resource reads as stopped at a glance.
          <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] leading-4 font-medium ${TONE_TEXT[statusTone(status)]}`} title={serverDown ? DOWN : statusLabel(status)}>
            {statusWord(status)}
            <StatusDot status={status} size="size-1.5" title={serverDown ? DOWN : null} />
          </span>
        ) : (
          <div className="pt-1">
            <StatusDot status={status} title={serverDown ? DOWN : null} />
          </div>
        )}
      </div>

      {node.urls?.length ? (
        <a
          className="relative mt-1.5 block max-w-full self-start truncate text-[11px] leading-5 text-neutral-500 hover:text-black hover:underline dark:text-fg-dim dark:hover:text-fg"
          href={node.urls[0]}
          target="_blank"
          rel="noopener noreferrer"
          title={node.urls[0]}
          onPointerDown={stop}
          onClick={stop}
        >
          {node.urls[0]!.replace(/^https?:\/\//, "")}
        </a>
      ) : null}

      {extra || security ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden h-5">
          {security ? (
            // The security marker, same as x-image-scan.marker: the icon is error (update_now) or neutral (no_fix).
            <span
              className={`inline-flex h-5 shrink-0 items-center gap-1 text-xs leading-none font-medium text-neutral-700 dark:text-white ${security.tooltip ? "cursor-help" : ""}`}
              role="img"
              aria-label={security.label}
              data-tooltip={security.tooltip || undefined}
              data-tooltip-wrap={security.tooltip ? "" : undefined}
            >
              <CanvasIcon name="shieldAlert" className={`size-4 ${security.status === "update_now" ? "text-error" : "text-neutral-500 dark:text-fg-dim"}`} />
              <span aria-hidden="true">{security.text}</span>
            </span>
          ) : null}
          {extra ? <span className={CHIP} title={props.zoneNames.join(", ")}>{`+${extra} ${extra === 1 ? "server" : "servers"}`}</span> : null}
        </div>
      ) : null}

      {children.length ? (
        <ul className="mt-2 border-t border-neutral-100 pt-1.5 dark:border-white/[0.06]">
          {children.slice(0, MAX_CHILDREN).map((child, i) => (
            <li key={i} className="flex h-5 items-center gap-2 text-[12px] leading-5">
              <StatusDot status={serverDown ? "unknown" : child.status} size="size-1.5" title={serverDown ? DOWN : null} />
              <span className="min-w-0 truncate">{child.name}</span>
            </li>
          ))}
          {children.length > MAX_CHILDREN ? <li className="h-5 text-[11px] leading-5 text-neutral-400 dark:text-fg-faint">{`+${children.length - MAX_CHILDREN} more`}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
