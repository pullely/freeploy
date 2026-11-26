// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Panel.svelte (Apache-2.0), modified.
// Side panel of the selected card or link. Connect view (shared variables, tags): a source card,
// a resource with its sources, or a source → resource link (DP-98); other views: a card or a
// diagram link, with the link's label field (saved on blur and Enter, Escape restores it) and
// "Remove link" for those who may edit (DP-92).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isSource, NO_SERVER, statusLabel, TYPE_LABELS, type CanvasGraph, type CanvasLink, type CanvasNode, type ConnectText } from "../../../lib/environment-canvas";
import { AddSection } from "./AddSection";
import { CanvasIcon } from "./Icon";
import { NodeIcon } from "./NodeIcon";
import { StatusDot } from "./StatusDot";

export type Selection = { kind: "node" | "link"; id: string } | null;

const ROW_BUTTON = "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-neutral-100 dark:hover:bg-white/[0.06]";
const smallButton = (danger: boolean) => `button h-6! shrink-0 px-2! text-[11px]! ${danger ? "button-error" : ""}`.trimEnd();
const TITLE_LINK = "[&[href]]:cursor-pointer [&[href]]:underline-offset-2 [&[href]]:hover:underline";
const LIST_BUTTON = "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-neutral-100 dark:hover:bg-white/[0.06]";
const FAINT = "text-[12px] text-neutral-400 dark:text-fg-faint";
const STATUS_PILL = "inline-flex h-6 items-center gap-1.5 text-[13px] text-neutral-700 dark:text-fg";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-neutral-100 px-4 py-3 dark:border-white/[0.06]">
      <h3 className="mb-1.5 text-[11px]! leading-4! font-medium! text-neutral-400 dark:text-fg-faint">{title}</h3>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="border-t border-neutral-100 px-4 py-3 text-[12px] text-neutral-500 dark:border-white/[0.06] dark:text-fg-faint">{children}</p>;
}

function Shell({ title, icon, top, onClose, footer, children }: { title: string; icon: string | CanvasNode; top: string; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  return (
    <aside
      className="absolute top-3 right-3 bottom-3 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-white/[0.08] dark:bg-panel"
      style={top ? { top } : undefined}
      data-ec-panel=""
    >
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
          {typeof icon === "string" ? <CanvasIcon name={icon} className="size-4" /> : <NodeIcon node={icon} />}
        </div>
        <h2 className="min-w-0 flex-1 truncate text-[14px]! leading-5! font-semibold! text-black dark:text-fg">{title}</h2>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-dim dark:hover:bg-white/[0.07] dark:hover:text-fg"
          title="Close"
          aria-label="Close panel"
          onClick={onClose}
        >
          <CanvasIcon name="x" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? <div className="border-t border-neutral-100 p-4 dark:border-white/[0.06]">{footer}</div> : null}
    </aside>
  );
}

export function Panel(props: {
  graph: CanvasGraph;
  node: CanvasNode | null;
  link: CanvasLink | null;
  canEdit: boolean;
  top: string;
  nodeById: (id: string) => CanvasNode | undefined;
  zoneNames: (node: CanvasNode) => string[];
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  /** Saves a link's label; false when it was not saved. */
  onLabel?: (link: CanvasLink, value: string) => Promise<boolean>;
  onDelete?: (link: CanvasLink) => Promise<void>;
  /** Connect view (shared variables, tags): its wording, and adding or removing a source on a resource. */
  connectView?: boolean;
  text?: ConnectText;
  onCreate?: (source: string, target: string) => Promise<void>;
  onRemove?: (link: CanvasLink) => Promise<void>;
}) {
  const { graph, node, link, nodeById, onSelect } = props;
  // Requests in flight, per link id: their buttons stay disabled until the request ends.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  async function run(id: string, request: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await request();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }
  // Diagram link label: saved on blur and Enter, Escape restores it. Follows the link while not focused.
  const labelInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(link?.label || "");
  const saved = useRef(link?.label || "");
  // What the field holds now: blur can follow Escape in the same tick, before React renders it.
  const typed = useRef(link?.label || "");
  const type = (value: string) => {
    typed.current = value;
    setLabel(value);
  };
  const current = link?.label || "";
  useEffect(() => {
    if (document.activeElement !== labelInput.current) {
      type(current);
      saved.current = current;
    }
  }, [current]);
  async function saveLabel() {
    if (!link || !props.onLabel) return;
    const value = typed.current.trim();
    if (value === saved.current) return;
    saved.current = value;
    if (!(await props.onLabel(link, value))) saved.current = link.label || "";
  }
  const links = graph.links;
  const text = props.text;
  const removeTitle = (l: CanvasLink) => (l.keys?.length ? `Delete ${l.keys.join(", ")} from ${nodeById(l.target)?.name}` : `Remove ${nodeById(l.source)?.name} from ${nodeById(l.target)?.name}`);
  const removeHint = (l: CanvasLink) => `${(l.keys ?? []).join(", ")} uses ${nodeById(l.source)?.reference || "the variable"} inside a longer value. Edit it on the resource.`;
  const removeButton = (l: CanvasLink) =>
    props.canEdit ? (
      <button type="button" className={smallButton(true)} title={l.removable ? removeTitle(l) : removeHint(l)} disabled={!l.removable || !!busy[l.id]} onClick={() => void run(l.id, () => props.onRemove?.(l) ?? Promise.resolve())}>
        Remove
      </button>
    ) : null;
  const meta = (n: CanvasNode) => (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <span className="text-[12px] text-neutral-500 dark:text-fg-faint">{TYPE_LABELS[n.type] || n.type}</span>
      <span className={STATUS_PILL}>
        <StatusDot status={n.status} size="size-1.5" />
        {statusLabel(n.status)}
      </span>
    </div>
  );
  const openButton = (n: CanvasNode, cls: string, label: string) => (
    <a className={`button ${cls} w-full`.replace("  ", " ")} href={n.link ?? undefined}>
      {label}
    </a>
  );

  if (props.connectView && text && node && isSource(node)) {
    const usedBy = links.filter((l) => l.source === node.id);
    const linked = new Set(usedBy.map((l) => l.target));
    return (
      <Shell title={node.name} icon={node} top={props.top} onClose={props.onClose} footer={node.link ? openButton(node, "", `Open ${(TYPE_LABELS[node.type] ?? "").toLowerCase()}`) : undefined}>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {node.reference ? (
            <code className="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:border-white/[0.1] dark:bg-white/[0.05] dark:text-fg-dim">{node.reference}</code>
          ) : null}
          {node.missing ? (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">Deleted</span>
          ) : null}
        </div>
        {node.missing ? (
          <Note>{`This shared variable was deleted. The resources below still reference it and get the text ${node.reference} instead of a value. Add the variable again, or remove the reference.`}</Note>
        ) : node.subtitle ? (
          <Section title="Description">
            <p className="text-[12px] break-words">{node.subtitle}</p>
          </Section>
        ) : null}
        <Section title={`${text.usedBy} (${usedBy.length})`}>
          <ul className="flex flex-col gap-1.5">
            {!usedBy.length ? <li className={FAINT}>{text.noTargets}</li> : null}
            {usedBy.map((l) => {
              const resource = nodeById(l.target);
              return (
                <li key={l.id} className="flex items-center gap-1">
                  <button type="button" className={ROW_BUTTON} title={resource?.context || ""} onClick={() => onSelect({ kind: "link", id: l.id })}>
                    <StatusDot status={resource?.status} size="size-1.5" />
                    <span className="min-w-0 flex-1 truncate">{resource?.name || "Unknown"}</span>
                    {l.label ? <span className="max-w-24 truncate font-mono text-[11px] text-neutral-400 dark:text-fg-faint">{l.label}</span> : null}
                  </button>
                  {removeButton(l)}
                </li>
              );
            })}
          </ul>
        </Section>
        {props.canEdit && !node.missing ? (
          <AddSection
            title="Add to resources"
            placeholder="Search resources"
            empty={text.allTargets}
            candidates={graph.nodes.filter((n) => !isSource(n) && !linked.has(n.id))}
            describe={(resource) => ({ title: `Add ${node.name} to ${resource.name}`, sub: resource.context || "" })}
            onAdd={(resource) => props.onCreate?.(node.id, resource.id) ?? Promise.resolve()}
          />
        ) : null}
        {!node.missing ? <Note>{props.canEdit ? text.note(node) : text.viewOnly}</Note> : null}
      </Shell>
    );
  }
  if (props.connectView && text && node) {
    const sources = links.filter((l) => l.target === node.id);
    const linked = new Set(sources.map((l) => l.source));
    return (
      <Shell title={node.name} icon={node} top={props.top} onClose={props.onClose} footer={node.link ? openButton(node, "button-highlighted", "Open") : undefined}>
        {meta(node)}
        {node.context ? (
          <Section title="Project / environment">
            <a className={`text-[12px] hover:underline ${TITLE_LINK}`} href={node.context_link || undefined} draggable="false">
              {node.context}
            </a>
          </Section>
        ) : null}
        <Section title={`${text.sources} (${sources.length})`}>
          <ul className="flex flex-col gap-1.5">
            {!sources.length ? <li className={FAINT}>{text.noSources}</li> : null}
            {sources.map((l) => {
              const source = nodeById(l.source);
              return (
                <li key={l.id} className="flex items-center gap-1">
                  <button type="button" className={ROW_BUTTON} onClick={() => onSelect({ kind: "node", id: l.source })}>
                    <CanvasIcon name={source?.type || "variable"} className={`size-3.5 ${l.missing ? "text-red-500" : "text-neutral-400 dark:text-fg-faint"}`} />
                    <span className={`min-w-0 flex-1 truncate ${source?.type === "variable" ? "font-mono" : ""}`.trimEnd()}>{source?.name || "Unknown"}</span>
                    {l.missing ? <span className="text-[11px] text-red-500">Deleted</span> : null}
                  </button>
                  {removeButton(l)}
                </li>
              );
            })}
          </ul>
        </Section>
        {props.canEdit ? (
          <AddSection
            title={text.addSources}
            placeholder={text.searchSources}
            empty={text.noMoreSources}
            candidates={graph.nodes.filter((n) => isSource(n) && !n.missing && !linked.has(n.id))}
            describe={(source) => ({ title: `Add ${source.name} to ${node.name}`, sub: source.type === "variable" ? source.subtitle || "" : "" })}
            onAdd={(source) => props.onCreate?.(source.id, node.id) ?? Promise.resolve()}
          />
        ) : null}
      </Shell>
    );
  }
  if (props.connectView && text && link) {
    const variable = nodeById(link.source);
    const resource = nodeById(link.target);
    return (
      <Shell
        title={`${variable?.name || text.source} → ${resource?.name || "Resource"}`}
        icon="link"
        top={props.top}
        onClose={props.onClose}
        footer={
          props.canEdit ? (
            <button type="button" className="button button-error w-full" title={link.removable ? removeTitle(link) : removeHint(link)} disabled={!link.removable || !!busy[link.id]} onClick={() => void run(link.id, () => props.onRemove?.(link) ?? Promise.resolve())}>
              Remove
            </button>
          ) : undefined
        }
      >
        <Section title="Ends">
          <div className="flex flex-col gap-1">
            {(
              [
                [text.source, variable],
                ["Resource", resource],
              ] as const
            ).map(([endLabel, end]) => (
              <button key={endLabel} type="button" className={ROW_BUTTON} onClick={() => end && onSelect({ kind: "node", id: end.id })}>
                <span className="w-14 text-[11px] text-neutral-400 dark:text-fg-faint">{endLabel}</span>
                <span className={`min-w-0 flex-1 truncate ${end?.type === "variable" ? "font-mono" : ""}`.trimEnd()}>{end?.name || "Unknown"}</span>
              </button>
            ))}
          </div>
        </Section>
        {link.keys?.length ? (
          <Section title={`Variables on ${resource?.name || "the resource"}`}>
            <div className="flex flex-wrap gap-1">
              {link.keys.map((key) => (
                <code key={key} className="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[11px] dark:border-white/[0.1] dark:bg-white/[0.05]">
                  {key}
                </code>
              ))}
            </div>
          </Section>
        ) : null}
        {link.missing ? <Note>{`The shared variable was deleted. ${resource?.name} gets the text ${variable?.reference} instead of a value.`}</Note> : null}
        {props.canEdit && !link.removable ? <Note>{removeHint(link)}</Note> : null}
      </Shell>
    );
  }
  if (node) {
    const servers = props.zoneNames(node);
    const nodeLinks = graph.links.filter((l) => l.source === node.id || l.target === node.id);
    return (
      <Shell
        title={node.name}
        icon={node}
        top={props.top}
        onClose={props.onClose}
        footer={
          node.link ? (
            <a className="button button-highlighted w-full" href={node.link}>
              Open
            </a>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <span className="text-[12px] text-neutral-500 dark:text-fg-faint">{TYPE_LABELS[node.type] || node.type}</span>
          <span className={STATUS_PILL}>
            <StatusDot status={node.status} size="size-1.5" />
            {statusLabel(node.status)}
          </span>
        </div>
        {node.subtitle ? (
          <Section title="Details">
            <p className="text-[12px] break-words">{node.subtitle}</p>
          </Section>
        ) : null}
        {node.urls?.length ? (
          <Section title={node.urls.length === 1 ? "URL" : "URLs"}>
            <ul className="flex flex-col gap-1">
              {node.urls.map((u, i) => (
                <li key={i} className="min-w-0">
                  <a className="inline-flex max-w-full items-center gap-1.5 text-[12px] text-neutral-600 hover:text-black hover:underline dark:text-fg-dim dark:hover:text-fg" href={u} target="_blank" rel="noopener noreferrer">
                    <span className="truncate">{u.replace(/^https?:\/\//, "")}</span>
                    <CanvasIcon name="external" className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title={servers.length > 1 ? "Servers" : "Server"}>
          <p className="text-[12px]">{servers.length ? servers.join(", ") : NO_SERVER}</p>
        </Section>
        {node.children?.length ? (
          <Section title="Containers">
            <ul className="flex flex-col">
              {node.children.map((child, i) => (
                <li key={i} className="flex h-6 items-center gap-2 text-[12px]" title={statusLabel(child.status)}>
                  <StatusDot status={child.status} size="size-1.5" />
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <span className="text-[11px] text-neutral-400 dark:text-fg-faint">{(child.type && TYPE_LABELS[child.type as keyof typeof TYPE_LABELS]) || child.type || ""}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title="Links">
          <ul className="flex flex-col gap-0.5">
            {!nodeLinks.length ? <li className={FAINT}>{props.canEdit ? "No links. Drag the dot on the right edge of a card to another card." : "No links."}</li> : null}
            {nodeLinks.map((l) => (
              <li key={l.id}>
                <button type="button" className={LIST_BUTTON} onClick={() => onSelect({ kind: "link", id: l.id })}>
                  <CanvasIcon name="link" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate">{nodeById(l.source === node.id ? l.target : l.source)?.name || "Unknown"}</span>
                  {l.label ? <span className="max-w-24 truncate text-[11px] text-neutral-400 dark:text-fg-faint">{l.label}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </Shell>
    );
  }
  if (link) {
    return (
      <Shell
        title={link.label || "Link"}
        icon="link"
        top={props.top}
        onClose={props.onClose}
        footer={
          props.canEdit ? (
            <button type="button" className="button button-error w-full" disabled={!!busy[link.id]} onClick={() => void run(link.id, () => props.onDelete?.(link) ?? Promise.resolve())}>
              Remove link
            </button>
          ) : undefined
        }
      >
        <Section title="Resources">
          <div className="flex flex-col gap-1">
            {(
              [
                ["From", link.source],
                ["To", link.target],
              ] as const
            ).map(([endLabel, id]) => {
              const end = nodeById(id);
              return (
                <button key={endLabel} type="button" className={LIST_BUTTON} onClick={() => onSelect({ kind: "node", id })}>
                  <span className="w-9 text-[11px] text-neutral-400 dark:text-fg-faint">{endLabel}</span>
                  <StatusDot status={end?.status} size="size-1.5" />
                  <span className="min-w-0 flex-1 truncate">{end?.name || "Unknown"}</span>
                </button>
              );
            })}
          </div>
        </Section>
        <Section title="Label">
          {props.canEdit ? (
            <input
              ref={labelInput}
              value={label}
              onChange={(e) => type(e.target.value)}
              className="input h-8 w-full text-[12px]"
              type="text"
              maxLength={255}
              placeholder="For example: reads from"
              aria-label="Link label"
              data-ec-label-input=""
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  labelInput.current?.blur();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  type(saved.current);
                  labelInput.current?.blur();
                }
              }}
              onBlur={() => void saveLabel()}
            />
          ) : (
            <p className="text-[12px]">{link.label || "No label"}</p>
          )}
        </Section>
        <Note>Links are for the diagram only. They do not change your resources.</Note>
      </Shell>
    );
  }
  return null;
}
