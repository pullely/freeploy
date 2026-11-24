// Derived from coollabsio/coolify@91b7e3e:resources/views/components/theme-controls.blade.php
// and resources/views/livewire/profile/appearance.blade.php (Apache-2.0), modified.
// /profile/appearance: the card grid of Coolify's theme controls, choices
// stored in localStorage under Coolify's keys and applied at once.
import { useState, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { appearance, setAppearance, type PageWidth, type Theme } from "../theme";

const CARD =
  "overflow-hidden rounded-[10px] border border-neutral-200 bg-white text-left transition-[border-color,box-shadow] hover:border-neutral-300 hover:shadow-sm dark:border-white/[0.07] dark:bg-white/[0.05] dark:hover:border-white/[0.12]";
const SELECTED = "border-coollabs! bg-coollabs/[0.06]! ring-2 ring-coollabs/25 dark:border-brand-light! dark:bg-brand-light/[0.08]! dark:ring-brand-light/25";
const cx = (base: string, selected: boolean) => (selected ? `${base} ${SELECTED}` : base);

function Section({ title, text, grid, children }: { title: string; text: string; grid: string; children: ReactNode }) {
  return (
    <section className="application-settings-section">
      <div className="application-settings-section-header">
        <div>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>
      </div>
      <div className={`application-settings-section-body grid gap-3 ${grid}`}>{children}</div>
    </section>
  );
}

function Caption({ label, description, selected }: { label: string; description: string; selected: boolean }) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-black dark:text-fg">{label}</span>
        <Reicon name="check-circle" className="size-4 text-coollabs dark:text-brand-light" {...(selected ? {} : { style: { display: "none" as const } })} />
      </div>
      <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">{description}</p>
    </div>
  );
}

function Choice({ selected, onPick, children }: { selected: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onPick} className={cx(`group ${CARD}`, selected)}>
      {children}
    </button>
  );
}

const THEMES: Array<{ value: Theme; label: string; description: string; preview: string }> = [
  { value: "light", label: "Light", description: "Bright surfaces and dark text.", preview: "bg-white" },
  { value: "system", label: "System", description: "Follow your operating system.", preview: "bg-gradient-to-r from-white via-neutral-400 to-[#050505]" },
  { value: "dark", label: "Dark", description: "Dark surfaces and soft contrast.", preview: "bg-[#181818]" },
];
const SCALES = [
  { value: "80", label: "80%", description: "Show more content on the screen.", size: "text-base" },
  { value: "90", label: "90%", description: "Smaller text and controls.", size: "text-lg" },
  { value: "100", label: "100%", description: "The default size.", size: "text-xl" },
];
const WIDTHS: Array<{ value: PageWidth; label: string; description: string }> = [
  { value: "full", label: "Full width", description: "Use all available space for page content." },
  { value: "centered", label: "Centered", description: "Keep content centered at a comfortable maximum width." },
];
const NAV_STYLES = [
  { value: "default", label: "Default", description: "Top bar and sidebars run edge to edge." },
  { value: "floating", label: "Floating", description: "Framed panels float on a dotted backdrop, like the canvas." },
];
const NAV_ITEMS = [
  { value: "3d", label: "3D", description: "Buttons and sidebar icons sit on a raised edge that lifts on hover." },
  { value: "flat", label: "Flat", description: "No raised edges. Sidebar items are plain rows with a highlight for the current page." },
];
const CHART_TIMES = [
  { value: "local", label: "Your time", description: "Show the time in the time zone of this browser.", lines: ["Oct 24, 12:30:33"] },
  {
    value: "utc",
    label: "Your time and UTC",
    description: "Also show the UTC time. Use it to compare with server logs.",
    lines: ["Your time: Oct 24, 12:30:33 GMT+2", "UTC: Oct 24, 10:30:33 UTC"],
  },
];

/** The custom theme's swatch (theme-controls/swatch.blade.php) with Coolify's default custom colours. */
function CustomSwatch() {
  return (
    <div className="flex overflow-hidden rounded-md border border-black/10 dark:border-white/10 h-12 w-24" aria-hidden="true">
      <div className="flex w-[38%] flex-col gap-1 p-1.5" style={{ background: "#160d24" }}>
        <span className="h-1 w-3/4 rounded-full opacity-50" style={{ background: "#f4f4f5" }} />
        <span className="h-2.5 w-full rounded-sm" style={{ background: "#341a5d" }} />
        <span className="flex items-center gap-1">
          <span className="h-1 w-1/2 rounded-full opacity-50" style={{ background: "#f4f4f5" }} />
          <span className="size-1.5 rounded-[2px]" style={{ background: "#6b16ed" }} />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-1.5" style={{ background: "#1a102b" }}>
        <span className="h-1 w-2/3 rounded-full opacity-60" style={{ background: "#f4f4f5" }} />
        <span className="h-1 w-1/2 rounded-full opacity-30" style={{ background: "#f4f4f5" }} />
        <span className="mt-auto h-2.5 w-full rounded-sm border" style={{ borderColor: "color-mix(in oklab, #f4f4f5 25%, transparent)" }} />
      </div>
    </div>
  );
}

export function AppearancePage() {
  const [theme, setTheme] = useState(appearance.theme);
  const [uiScale, setUiScale] = useState(appearance.uiScale);
  const [pageWidth, setPageWidth] = useState(appearance.pageWidth);
  const [navStyle, setNavStyle] = useState(appearance.navStyle);
  const [navItems, setNavItems] = useState(appearance.navItems);
  const [chartTimes, setChartTimes] = useState(appearance.chartTimes);
  const pick = <T,>(set: (v: T) => void, store: (v: T) => void) => (v: T) => {
    set(v);
    store(v);
  };
  const pickTheme = pick(setTheme, setAppearance.theme);

  return (
    <Layout title="Profile" href="/profile" documentTitle="Appearance" searchTitle="Search this page and everything (Press / or Ctrl+K, then Tab to switch)">
      <div className="mt-8 flex w-full max-w-none flex-col gap-6 lg:mt-3">
        <Section title="Color theme" text="Choose the color scheme used in this browser." grid="sm:grid-cols-2 lg:grid-cols-4">
          {THEMES.map((o) => (
            <div
              key={o.value}
              role="button"
              tabIndex={0}
              onClick={() => pickTheme(o.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  pickTheme(o.value);
                }
              }}
              className={cx(`group relative ${CARD}`, theme === o.value)}
            >
              <div className={`h-20 ${o.preview} border-b border-neutral-200 dark:border-white/[0.07]`}>
                <div className="flex h-full items-center justify-center">
                  <div className="h-8 w-20 rounded-md border border-black/10 bg-neutral-100/80 shadow-sm dark:border-white/10 dark:bg-black/20" />
                </div>
              </div>
              <Caption label={o.label} description={o.description} selected={theme === o.value} />
            </div>
          ))}
          {/* The custom theme dialog (presets, colours, share code) is a later DP3 task. */}
          <div role="button" tabIndex={0} aria-haspopup="dialog" aria-expanded="false" className={cx(`group block w-full ${CARD}`, theme === "custom")}>
            <div className="flex h-20 items-center justify-center border-b border-neutral-200 bg-neutral-100 dark:border-white/[0.07] dark:bg-black/20">
              <CustomSwatch />
            </div>
            <Caption label="Custom" description="Pick a preset or your own colors." selected={theme === "custom"} />
          </div>
        </Section>

        <Section title="UI scale" text="Choose the size of text and controls. Phones always use 100%." grid="sm:grid-cols-3">
          {SCALES.map((o) => (
            <Choice key={o.value} selected={uiScale === o.value} onPick={() => pick(setUiScale, setAppearance.uiScale)(o.value)}>
              <div className="flex h-20 items-center justify-center border-b border-neutral-200 bg-neutral-50 px-4 dark:border-white/[0.07] dark:bg-black/15">
                <span className={`${o.size} font-semibold text-black dark:text-fg`}>Aa</span>
              </div>
              <Caption label={o.label} description={o.description} selected={uiScale === o.value} />
            </Choice>
          ))}
        </Section>

        <Section title="Page width" text="Choose how content uses the available browser width." grid="sm:grid-cols-2">
          {WIDTHS.map((o) => (
            <Choice key={o.value} selected={pageWidth === o.value} onPick={() => pick(setPageWidth, setAppearance.pageWidth)(o.value)}>
              <div className="flex h-20 items-center border-b border-neutral-200 bg-neutral-50 px-4 dark:border-white/[0.07] dark:bg-black/15">
                <div className="flex h-11 w-full gap-1.5 rounded-md border border-neutral-300 bg-white p-1.5 dark:border-white/15 dark:bg-[#181818]">
                  <div className="w-3 shrink-0 rounded-sm bg-neutral-200 dark:bg-white/10" />
                  <div className={`h-full rounded-sm bg-neutral-200 dark:bg-white/10 ${o.value === "full" ? "w-full" : "mx-auto w-2/3"}`} />
                </div>
              </div>
              <Caption label={o.label} description={o.description} selected={pageWidth === o.value} />
            </Choice>
          ))}
        </Section>

        <Section title="Navigation style" text="Choose how the top bar and sidebars sit on the page." grid="sm:grid-cols-2">
          {NAV_STYLES.map((o) => {
            const floating = o.value === "floating";
            return (
              <Choice key={o.value} selected={navStyle === o.value} onPick={() => pick(setNavStyle, setAppearance.navStyle)(o.value)}>
                <div className={`flex h-20 border-b border-neutral-200 bg-neutral-50 dark:border-white/[0.07] dark:bg-black/15${floating ? " gap-1.5 p-1.5" : ""}`}>
                  <div
                    className={`flex flex-col items-center gap-1.5 bg-white px-2 py-2 dark:bg-white/[0.04] ${floating ? "rounded-lg border border-neutral-200 dark:border-white/[0.08]" : "border-r border-neutral-200 dark:border-white/[0.07]"}`}
                  >
                    {["servers", "projects"].map((icon) => (
                      <span
                        key={icon}
                        className="flex size-6 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim"
                      >
                        <Reicon name={icon} className="size-3.5" />
                      </span>
                    ))}
                  </div>
                  <div
                    className={`h-5 flex-1 bg-white dark:bg-white/[0.04] ${floating ? "rounded-lg border border-neutral-200 dark:border-white/[0.08]" : "border-b border-neutral-200 dark:border-white/[0.07]"}`}
                  />
                </div>
                <Caption label={o.label} description={o.description} selected={navStyle === o.value} />
              </Choice>
            );
          })}
        </Section>

        <Section title="Style" text="Choose how buttons and sidebar items look." grid="sm:grid-cols-2">
          {NAV_ITEMS.map((o) => {
            const tiles = o.value === "3d";
            return (
              <Choice key={o.value} selected={navItems === o.value} onPick={() => pick(setNavItems, setAppearance.navItems)(o.value)}>
                <div className="flex h-20 flex-col justify-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-4 dark:border-white/[0.07] dark:bg-black/15">
                  {["servers", "projects"].map((icon, i) => (
                    <div
                      key={icon}
                      className={[
                        "flex items-center gap-2 rounded-md text-neutral-500 dark:text-fg-dim",
                        !tiles ? "px-1.5 py-1" : "",
                        !tiles && i === 0 ? "bg-neutral-200/70 dark:bg-white/[0.08]" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <span
                        className={
                          tiles
                            ? "flex items-center justify-center size-6 rounded-md border border-neutral-200 bg-white shadow-[0_2px_0_rgb(0_0_0/0.22)] dark:border-white/[0.09] dark:bg-white/[0.04] dark:shadow-[0_2px_0_rgb(255_255_255/0.08)]"
                            : "flex items-center justify-center"
                        }
                      >
                        <Reicon name={icon} className="size-3.5" />
                      </span>
                      <span className="h-1.5 w-16 rounded-full bg-neutral-200 dark:bg-white/10" />
                    </div>
                  ))}
                </div>
                <Caption label={o.label} description={o.description} selected={navItems === o.value} />
              </Choice>
            );
          })}
        </Section>

        <Section title="Chart times" text="Choose which times chart tooltips show." grid="sm:grid-cols-2">
          {CHART_TIMES.map((o) => (
            <Choice key={o.value} selected={chartTimes === o.value} onPick={() => pick(setChartTimes, setAppearance.chartTimes)(o.value)}>
              <div className="flex h-20 items-center justify-center border-b border-neutral-200 bg-neutral-50 px-4 dark:border-white/[0.07] dark:bg-black/15">
                <div className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-[11px] leading-4 dark:border-white/15 dark:bg-[#181818]">
                  <div className="text-black dark:text-fg">
                    CPU: <span className="font-semibold">4.3%</span>
                  </div>
                  {o.lines.map((line) => (
                    <div key={line} className="text-neutral-500 dark:text-fg-dim">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
              <Caption label={o.label} description={o.description} selected={chartTimes === o.value} />
            </Choice>
          ))}
        </Section>
      </div>
    </Layout>
  );
}
