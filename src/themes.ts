import type { ThemeSettings } from "./bridge";

export interface ThemeDef {
  name: string;
  label: string;
  /** CSS variable overrides on top of the :root defaults. */
  vars: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  { name: "noct", label: "Noct", vars: {} },
  {
    name: "ember",
    label: "Ember",
    vars: {
      "--bg": "#120a0a",
      "--panel": "rgba(36, 20, 16, 0.68)",
      "--accent": "#f5f5f4",
      "--accent2": "#fb923c",
    },
  },
  {
    name: "glacier",
    label: "Glacier",
    vars: {
      "--bg": "#080d16",
      "--panel": "rgba(12, 22, 38, 0.68)",
      "--text": "#eaf2ff",
      "--dim": "#a7b8dd",
      "--accent": "#f1f5f9",
      "--accent2": "#7dd3fc",
    },
  },
  {
    name: "mono",
    label: "Mono",
    vars: {
      "--bg": "#0b0b0c",
      "--panel": "rgba(20, 20, 22, 0.68)",
      "--dim": "#b6bac4",
      "--accent": "#e5e7eb",
      "--accent2": "#9ca3af",
    },
  },
  {
    name: "rose",
    label: "Rose",
    vars: {
      "--bg": "#150a10",
      "--panel": "rgba(34, 14, 24, 0.68)",
      "--accent": "#fdf2f8",
      "--accent2": "#f472b6",
    },
  },
  {
    name: "meadow",
    label: "Meadow",
    vars: {
      "--bg": "#08120c",
      "--panel": "rgba(12, 26, 18, 0.68)",
      "--accent": "#ecfdf5",
      "--accent2": "#4ade80",
    },
  },
  {
    name: "dusk",
    label: "Dusk",
    vars: {
      "--bg": "#100a16",
      "--panel": "rgba(26, 14, 36, 0.68)",
      "--accent": "#fafaf9",
      "--accent2": "#fdba74",
    },
  },
];

/** Values matching the :root block in styles.css, for preset fallbacks. */
export const ROOT_VARS: Record<string, string> = {
  "--bg": "#0b0b0e",
  "--panel": "rgba(14, 16, 24, 0.68)",
  "--line": "rgba(255, 255, 255, 0.16)",
  "--text": "#f4f5fa",
  "--dim": "#c6cbdb",
  "--accent": "#e5e7eb",
  "--accent2": "#9ca3af",
};

/** Resolved value of a theme variable for a preset (preset var, else :root). */
export function presetVar(themeName: string, varName: string): string {
  const def = THEMES.find((d) => d.name === themeName) ?? THEMES[0];
  return def.vars[varName] ?? ROOT_VARS[varName] ?? "";
}

/** Current computed value of a CSS variable on this window. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const KNOWN_VARS = [
  "--bg",
  "--panel",
  "--line",
  "--text",
  "--dim",
  "--accent",
  "--accent2",
];

/** Apply a theme to the current window: preset vars, then user overrides. */
export function applyTheme(theme: ThemeSettings) {
  const def = THEMES.find((d) => d.name === theme.name) ?? THEMES[0];
  const root = document.documentElement;
  for (const v of KNOWN_VARS) root.style.removeProperty(v);
  for (const [k, val] of Object.entries(def.vars)) root.style.setProperty(k, val);
  if (theme.accent) root.style.setProperty("--accent", theme.accent);
  if (theme.accent2) root.style.setProperty("--accent2", theme.accent2);
}

/** Artwork-driven accents (iBaila-style): the two most vibrant colors from
 * the playing track's cover, applied on top of the theme. Only runs when
 * the dynamic pref is on and the user hasn't pinned manual accents —
 * `applyTheme` clears these again on the next theme change. */
export function applyDynAccent(theme: ThemeSettings, accent: string, accent2: string | null) {
  if (!theme.dynamic) return;
  const root = document.documentElement;
  /* Each manual pick freezes only its own color — pinning --accent must
     not stop the artwork from still driving --accent2. */
  if (!theme.accent) root.style.setProperty("--accent", accent);
  if (accent2 && !theme.accent2) root.style.setProperty("--accent2", accent2);
}
