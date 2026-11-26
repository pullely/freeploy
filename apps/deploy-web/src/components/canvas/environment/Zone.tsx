// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Zone.svelte (Apache-2.0), modified.
// A zone frame (a server) with its header; the header drags the zone when it is movable.
// Server canvas zones (zone.details) add a second row: host facts, proxy, live usage and a status summary.
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatMemory, formatUptime, NO_SERVER, statusSummary, zoneHeader, type CanvasNode, type Tone, type ZoneBox } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";

const SUMMARY: Array<[Tone, string, string]> = [
  ["ok", "running", "bg-emerald-500"],
  ["busy", "starting", "bg-warning"],
  ["warn", "degraded", "bg-warning"],
  ["bad", "stopped", "bg-red-500"],
  ["idle", "unknown", "bg-neutral-400 dark:bg-neutral-500"],
];
const USAGE: Array<["cpu" | "memory" | "disk", string]> = [
  ["cpu", "CPU"],
  ["memory", "Memory"],
  ["disk", "Disk"],
];
const usageTone = (value: number) => (value >= 90 ? "text-red-600 dark:text-red-400" : value >= 75 ? "text-warning-700 dark:text-warning" : "text-neutral-600 dark:text-fg-dim");
const SEP = "h-3 w-px shrink-0 bg-neutral-200 dark:bg-white/[0.1]";

export function Zone(props: {
  box: ZoneBox;
  movable: boolean;
  grabBody?: boolean;
  nodes: CanvasNode[];
  usage?: Partial<Record<"cpu" | "memory" | "disk", number | null>> | null;
  onPress: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { box, movable, grabBody = false, usage = null } = props;
  // The server IP stays hidden until the user asks for it (screen sharing, screenshots).
  const [showIp, setShowIp] = useState(false);
  const zone = box.zone;
  const ok = zone?.is_reachable && zone?.is_usable;
  const title = movable ? (grabBody ? "Drag to move this zone" : "Drag to move every card in this zone") : !zone ? "Resources without a server" : undefined;
  const details = zone?.details ?? null;
  const uptime = details?.uptime_since ? formatUptime(details.uptime_since) : null;
  const host = details
    ? [details.os, details.arch, details.cpus ? `${details.cpus} ${details.cpus === 1 ? "CPU" : "CPUs"}` : null, formatMemory(details.memory_bytes), uptime ? `up ${uptime}` : null].filter((v): v is string => !!v)
    : [];
  const proxyRunning = details?.proxy?.status === "running";
  const summary = details && zone?.is_reachable ? statusSummary(props.nodes) : null;
  return (
    <div
      className={`absolute rounded-2xl border border-neutral-200 bg-[color-mix(in_oklab,var(--color-neutral-50),white_50%)] dark:border-white/[0.07] dark:bg-[color-mix(in_oklab,var(--color-app),var(--color-panel)_35%)] ${grabBody ? "cursor-grab active:cursor-grabbing" : ""}`}
      data-ec-zone-drag={grabBody || undefined}
      title={grabBody ? title : undefined}
      onPointerDown={grabBody ? props.onPress : undefined}
      style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }}
    >
      <div className={`px-4 ${movable ? "cursor-grab active:cursor-grabbing" : ""}`} style={{ height: `${zoneHeader(zone)}px` }} data-ec-zone-header="" title={grabBody ? undefined : title} role="presentation" onPointerDown={grabBody ? undefined : props.onPress}>
        <div className="flex h-10 items-center gap-2 text-[12px]">
          <CanvasIcon name={zone?.icon || "server"} className="size-3.5 text-neutral-400 dark:text-fg-faint" />
          <a className="truncate font-semibold text-neutral-700 dark:text-fg [&[href]]:cursor-pointer [&[href]]:underline-offset-2 [&[href]]:hover:underline" href={zone?.link || undefined} draggable="false">
            {box.name || NO_SERVER}
          </a>
          {/* Zones with an icon are not server zones (connect view). */}
          {zone && !zone.icon ? (
            <>
              {ok ? (
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="Reachable"></span>
              ) : (
                // Spelled out: the status of every card on this server is unknown while it is down.
                <span
                  className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium ${
                    zone.is_reachable ? "border-warning/40 bg-warning/10 text-warning-700 dark:text-warning" : "border-red-200 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
                  }`}
                  title={zone.is_reachable ? "Freeploy can connect to this server, but cannot use it (for example, Docker is missing)" : "Freeploy cannot connect to this server. The status of its resources is unknown."}
                >
                  <span className={`size-1.5 rounded-full ${zone.is_reachable ? "bg-warning" : "bg-red-500"}`}></span>
                  {zone.is_reachable ? "Not usable" : "Unreachable"}
                </span>
              )}
              {zone.ip ? (
                <button
                  type="button"
                  className="shrink-0 font-mono text-[11px] text-neutral-400 hover:text-neutral-600 dark:text-fg-faint dark:hover:text-fg-dim"
                  title={showIp ? "Hide IP address" : "Show IP address"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setShowIp(!showIp)}
                >
                  {showIp ? zone.ip : "Show IP"}
                </button>
              ) : null}
              {summary ? (
                <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] text-neutral-500 dark:text-fg-dim" title="Resources on this server by status">
                  {SUMMARY.map(([tone, label, dot]) =>
                    summary[tone] ? (
                      <span key={tone} className="inline-flex items-center gap-1">
                        <span className={`size-1.5 rounded-full ${dot}`}></span>
                        {`${summary[tone]} ${label}`}
                      </span>
                    ) : null,
                  )}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        {details ? (
          <div className="flex h-5 min-w-0 items-center gap-2.5 overflow-hidden text-[11px] whitespace-nowrap text-neutral-500 dark:text-fg-faint">
            {host.length ? (
              <span className="truncate" title="Operating system, architecture, CPUs, memory and uptime">
                {host.join(" · ")}
              </span>
            ) : null}
            {details.proxy ? (
              <>
                {host.length ? <span className={SEP}></span> : null}
                <span className="inline-flex shrink-0 items-center gap-1.5" title={`Proxy: ${details.proxy.status || "unknown"}`}>
                  <span className={`size-1.5 rounded-full ${proxyRunning ? "bg-emerald-500" : details.proxy.status ? "bg-red-500" : "bg-neutral-400"}`}></span>
                  {details.proxy.type.charAt(0) + details.proxy.type.slice(1).toLowerCase()}
                  {proxyRunning ? "" : ` ${details.proxy.status || ""}`}
                </span>
              </>
            ) : null}
            {usage && USAGE.some(([key]) => usage[key] !== null && usage[key] !== undefined) ? (
              <>
                <span className={SEP}></span>
                {USAGE.map(([key, label]) => {
                  const value = usage[key];
                  return value !== null && value !== undefined ? (
                    <span key={key} className="shrink-0" title={`${label} usage (last minute)`}>
                      {`${label} `}
                      <span className={`font-medium tabular-nums ${usageTone(value)}`}>{`${Math.round(value)}%`}</span>
                    </span>
                  ) : null;
                })}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
