// Derived from coollabsio/coolify@91b7e3e:resources/views/layouts/base.blade.php (Apache-2.0), modified.
// Coolify keeps appearance in localStorage and applies it to <html> before
// render: theme ('dark' default, 'light', 'system', 'custom'), navStyle,
// navItems and uiScale; pageWidth and chartTimes are read where they apply.
import { applyCustomTheme, hexToOklch, storedCustomTheme, themeAccentForeground } from "./lib/custom-theme";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: Coolify's defaults
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts this page only */
  }
}

export type Theme = "light" | "system" | "dark" | "custom";
export type PageWidth = "full" | "centered";

export const appearance = {
  theme: (): Theme => (read("theme") === "purple" ? "custom" : ((read("theme") as Theme | null) ?? "dark")),
  uiScale: (): string => (["80", "90", "100"].includes(read("uiScale") ?? "") ? read("uiScale")! : "100"),
  pageWidth: (): PageWidth => (read("pageWidth") === "full" ? "full" : "centered"),
  navStyle: (): string => (read("navStyle") === "floating" ? "floating" : "default"),
  navItems: (): string => (read("navItems") === "flat" ? "flat" : "3d"),
  chartTimes: (): string => (read("chartTimes") === "utc" ? "utc" : "local"),
};

export function applyStoredTheme(): void {
  const root = document.documentElement;
  root.dataset.navStyle = appearance.navStyle();
  root.dataset.navItems = appearance.navItems();
  root.dataset.uiScale = appearance.uiScale();
  const theme = appearance.theme();
  if (theme === "custom") {
    applyCustomTheme(storedCustomTheme());
    return;
  }
  const isDark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", isDark);
  root.dataset.theme = isDark ? "dark" : "light";
  delete root.dataset.sidebarScheme;
  root.style.setProperty("--theme-base-color", hexToOklch(read("themeColor") ?? "#6b16ed"));
  root.style.setProperty("--theme-accent-foreground", themeAccentForeground(read("themeColor") ?? "#6b16ed"));
}

/** themeControls() setters: store the choice the way Coolify does and apply it. */
export const setAppearance = {
  theme(value: Theme) {
    write("theme", value);
    applyStoredTheme();
  },
  uiScale(value: string) {
    write("uiScale", value);
    document.documentElement.dataset.uiScale = value;
  },
  pageWidth(value: PageWidth) {
    write("pageWidth", value);
    window.dispatchEvent(new CustomEvent("page-width-changed", { detail: value }));
  },
  navStyle(value: string) {
    write("navStyle", value);
    document.documentElement.dataset.navStyle = value;
  },
  navItems(value: string) {
    write("navItems", value);
    document.documentElement.dataset.navItems = value;
  },
  chartTimes(value: string) {
    write("chartTimes", value);
  },
};

/**
 * The <html> attributes and CSS variables Coolify's base layout sets before
 * render (layouts/base.blade.php) that do not depend on stored choices.
 */
export function applyLayoutDefaults(): void {
  const html = document.documentElement;
  html.lang = "en";
  html.style.setProperty("--theme-base-color", "oklch(49.65% 0.2709 289.33)");
  html.style.setProperty("--theme-accent-foreground", "oklch(100% 0 0)");
  document.body.className = "dark:text-inherit text-black";
}
