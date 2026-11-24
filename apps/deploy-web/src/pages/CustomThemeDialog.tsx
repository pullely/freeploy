// Derived from coollabsio/coolify@91b7e3e:resources/views/components/theme-controls.blade.php
// (the custom theme dialog), components/theme-controls/swatch.blade.php and themeControls()
// in layouts/base.blade.php (Apache-2.0), modified.
import { useState } from "react";
import { createPortal } from "react-dom";
import { Reicon } from "../components/Reicon";
import {
  KEYS,
  PRESETS,
  parseCustomTheme,
  readableTextOn,
  serializeCustomTheme,
  themeAccentFill,
  themeAccentForeground,
  type CustomTheme,
  type Preset,
} from "../lib/custom-theme";

export function Swatch({ theme, className }: { theme: CustomTheme; className: string }) {
  const on = readableTextOn;
  return (
    <div className={`flex overflow-hidden rounded-md border border-black/10 dark:border-white/10 ${className}`} aria-hidden="true">
      <div className="flex w-[38%] flex-col gap-1 p-1.5" style={{ background: theme.sidebar }}>
        <span className="h-1 w-3/4 rounded-full opacity-50" style={{ background: on(theme.sidebar) }} />
        <span className="h-2.5 w-full rounded-sm" style={{ background: theme.selected }} />
        <span className="flex items-center gap-1">
          <span className="h-1 w-1/2 rounded-full opacity-50" style={{ background: on(theme.sidebar) }} />
          <span className="size-1.5 rounded-[2px]" style={{ background: theme.accent }} />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: theme.background }}>
        <span className="h-1 w-2/3 rounded-full opacity-60" style={{ background: on(theme.background) }} />
        <span className="h-1 w-1/2 rounded-full opacity-30" style={{ background: on(theme.background) }} />
        <span className="mt-auto h-2.5 w-full rounded-sm border" style={{ borderColor: `color-mix(in oklab, ${on(theme.background)} 25%, transparent)` }} />
      </div>
    </div>
  );
}

const LABELS: Record<(typeof KEYS)[number], [string, string]> = {
  sidebar: ["Sidebar", "The navigation on the left"],
  selected: ["Selected", "The current page in the sidebar"],
  accent: ["Accent", "Buttons, links, and highlights"],
  background: ["Background", "Pages, cards, and panels"],
};

/** The dialog edits a draft; Save applies it. A null draft is the built-in Dark theme. */
export function CustomThemeDialog({ initial, onClose, onSave }: { initial: CustomTheme | null; onClose: () => void; onSave: (t: CustomTheme | null) => void }) {
  const [draft, setDraft] = useState<CustomTheme | null>(initial);
  const colors = draft ?? PRESETS[0]!.swatch!;
  const [shareCode, setShareCode] = useState(serializeCustomTheme(colors));
  const [invalid, setInvalid] = useState(false);
  const [copied, setCopied] = useState(false);
  const pick = (t: CustomTheme | null) => {
    setDraft(t);
    setShareCode(serializeCustomTheme(t ?? PRESETS[0]!.swatch!));
    setInvalid(false);
  };
  const isDraftPreset = (p: Preset) => (p.theme === null || draft === null ? p.theme === draft : serializeCustomTheme(p.theme) === serializeCustomTheme(draft));
  const setColor = (key: (typeof KEYS)[number], value: string) => {
    const t = parseCustomTheme(serializeCustomTheme({ ...colors, [key]: value }));
    if (t) pick(t);
  };
  const on = readableTextOn;
  const card = { background: `color-mix(in oklab, ${on(colors.background)} 4%, ${colors.background})`, borderColor: `color-mix(in oklab, ${on(colors.background)} 14%, ${colors.background})` };

  return createPortal(
    <div className="fixed inset-0 z-99 overflow-hidden" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="absolute inset-0 h-full w-full bg-black/50 backdrop-blur-[2px]" />
      <div className="relative flex min-h-full items-start justify-center p-2 sm:items-center sm:p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-theme-title"
          className="application-settings-form application-settings-section relative flex max-h-[calc(100dvh-1rem)] w-full max-w-5xl flex-col overflow-hidden sm:max-h-[calc(100dvh-2rem)]"
          style={{ boxShadow: "0 0 0 1px var(--coollabs-hairline), var(--shadow-modal)" }}
        >
          <header className="shrink-0">
            <div className="min-w-0 flex-1 py-0.5">
              <h3 id="custom-theme-title" className="truncate">
                Custom theme
              </h3>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-fg-dim">Colors of Freeploy in this browser. Text stays readable on every color.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-neutral-500 outline-0 transition-colors hover:bg-neutral-100 hover:text-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
            >
              <Reicon name="x" className="size-4" />
              <span className="sr-only">Close</span>
            </button>
          </header>
          <div className="application-settings-section-body grid min-h-0 flex-1 gap-6 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div>
              <div className="mb-2 text-xs font-medium text-neutral-500 dark:text-fg-dim">Presets</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => pick(p.theme && { ...p.theme })}
                    aria-pressed={isDraftPreset(p)}
                    className="group flex flex-col gap-1.5 rounded-lg p-1 text-left outline-0 focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    <Swatch
                      theme={p.theme ?? p.swatch!}
                      className={`h-14 w-full transition-shadow group-hover:shadow-md ${isDraftPreset(p) ? "ring-2 ring-coollabs ring-offset-2 ring-offset-white dark:ring-brand-light dark:ring-offset-panel" : ""}`}
                    />
                    <span className="truncate text-xs text-neutral-600 dark:text-fg-dim">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex h-48 overflow-hidden rounded-lg border border-neutral-200 text-xs dark:border-white/[0.08]" aria-hidden="true">
                <div className="flex w-2/5 flex-col gap-0.5 p-2.5" style={{ background: colors.sidebar, color: on(colors.sidebar) }}>
                  <div className="mb-2 px-2 text-sm font-semibold">Freeploy</div>
                  <div className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-75">
                    <Reicon name="dashboard" className="size-3.5" /> Dashboard
                  </div>
                  <div className="flex items-center gap-2 rounded-md px-2 py-1.5 font-medium" style={{ background: colors.selected, color: on(colors.selected) }}>
                    <Reicon name="projects" className="size-3.5" /> Projects
                  </div>
                  <div className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-75">
                    <Reicon name="servers" className="size-3.5" /> Servers
                    <span className="ml-auto rounded-full px-1.5 text-[10px] font-semibold" style={{ background: themeAccentFill(colors.accent), color: themeAccentForeground(colors.accent) }}>
                      3
                    </span>
                  </div>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2 p-3" style={{ background: colors.background, color: on(colors.background) }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">Projects</span>
                    <span className="rounded-md px-2 py-1 text-[11px] font-medium" style={{ background: themeAccentFill(colors.accent), color: themeAccentForeground(colors.accent) }}>
                      + New
                    </span>
                  </div>
                  <div className="rounded-md border p-2.5" style={card}>
                    <div className="font-medium">My first project</div>
                    <div className="mt-0.5 opacity-60">production</div>
                  </div>
                  <div className="rounded-md border p-2.5" style={card}>
                    <div className="font-medium">Website</div>
                    <div className="mt-0.5 opacity-60">staging</div>
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-neutral-500 dark:text-fg-dim">Colors</div>
                <div className="flex flex-col gap-2.5">
                  {KEYS.map((key) => (
                    <div key={key} className="flex items-center gap-3">
                      <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md border border-black/10 shadow-sm dark:border-white/15">
                        <span className="absolute inset-0" style={{ background: colors[key] }} />
                        <input
                          type="color"
                          autoComplete="off"
                          value={colors[key]}
                          onChange={(e) => setColor(key, e.target.value)}
                          aria-label={`${LABELS[key][0]} color`}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </label>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-black dark:text-fg">{LABELS[key][0]}</div>
                        <div className="truncate text-xs text-neutral-500 dark:text-fg-dim">{LABELS[key][1]}</div>
                      </div>
                      <input
                        key={colors[key]}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={7}
                        defaultValue={colors[key]}
                        onBlur={(e) => setColor(key, e.target.value)}
                        aria-label={`${LABELS[key][0]} hex color`}
                        className="input w-28! shrink-0 font-mono text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="custom-theme-share-code" className="mb-2 block text-xs font-medium text-neutral-500 dark:text-fg-dim">
                  Share code
                </label>
                <div className="flex gap-2">
                  <input
                    id="custom-theme-share-code"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={shareCode}
                    onChange={(e) => {
                      setShareCode(e.target.value);
                      const t = parseCustomTheme(e.target.value);
                      if (t) {
                        setDraft(t);
                        setInvalid(false);
                      } else setInvalid(e.target.value.trim() !== "");
                    }}
                    onBlur={() => (setShareCode(serializeCustomTheme(colors)), setInvalid(false))}
                    aria-invalid={invalid}
                    className={`input min-w-0 flex-1 font-mono text-sm ${invalid ? "border-error! ring-error!" : ""}`}
                  />
                  <button
                    type="button"
                    aria-label="Copy share code"
                    className="button shrink-0 px-2.5"
                    onClick={() => void navigator.clipboard.writeText(shareCode).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
                  >
                    <Reicon name={copied ? "check" : "copy"} className={copied ? "size-4 text-success" : "size-4"} />
                  </button>
                </div>
                <p className={`mt-1.5 text-xs ${invalid ? "text-error" : "text-neutral-500 dark:text-fg-dim"}`}>
                  {invalid ? "Enter four hex colors, separated by commas." : "Paste a code that someone shared, or copy yours."}
                </p>
              </div>
            </div>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-neutral-200 px-4 py-3 dark:border-white/[0.08]">
            <button className="button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button {...({ ishighlighted: "" } as object)} className="button" type="button" onClick={() => onSave(draft)}>
              Save theme
            </button>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}
