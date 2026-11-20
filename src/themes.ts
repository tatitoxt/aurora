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
      "--panel": "rgba(40, 22, 18, 0.62)",
      "--accent": "#f97316",
      "--accent2": "#f43f5e",
    },
  },
  {
    name: "glacier",
    label: "Glacier",
    vars: {
      "--bg": "#080d16",
      "--panel": "rgba(14, 24, 40, 0.62)",
      "--text": "#eaf2ff",
      "--dim": "#93a5c9",
      "--accent": "#38bdf8",
      "--accent2": "#818cf8",
    },
  },
  {
    name: "mono",
    label: "Mono",
    vars: {
      "--bg": "#0b0b0c",
      "--panel": "rgba(24, 24, 26, 0.66)",
      "--dim": "#8b8f98",
      "--accent": "#e5e7eb",
      "--accent2": "#9ca3af",
    },
  },
];

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
