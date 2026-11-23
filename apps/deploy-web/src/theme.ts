// Derived from coollabsio/coolify@91b7e3e:resources/views/layouts/base.blade.php (Apache-2.0), modified.
// Coolify reads the theme from localStorage before render ('dark' default,
// 'light', 'system') and toggles the `dark` class on <html>.
export function applyStoredTheme(): void {
  let theme = "dark";
  try {
    theme = localStorage.getItem("theme") === "purple" ? "custom" : localStorage.getItem("theme") || "dark";
  } catch {
    /* storage blocked: Coolify's default */
  }
  const isDark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

/**
 * The <html> attributes and CSS variables Coolify's base layout sets before
 * render (layouts/base.blade.php): navigation style, item style, UI scale and
 * the default theme colour, as on the reference.
 */
export function applyLayoutDefaults(): void {
  const html = document.documentElement;
  html.lang = "en";
  html.setAttribute("data-nav-style", "default");
  html.setAttribute("data-nav-items", "3d");
  html.setAttribute("data-ui-scale", "100");
  html.style.setProperty("--theme-base-color", "oklch(49.65% 0.2709 289.33)");
  html.style.setProperty("--theme-accent-foreground", "oklch(100% 0 0)");
  document.body.className = "dark:text-inherit text-black";
}
