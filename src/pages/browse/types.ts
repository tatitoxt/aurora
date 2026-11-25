/** Shared types, constants and pure helpers for the Browse page. */
import type { MsgKey } from "../../i18n";

/** Providers tried, in order, when playing a catalog/stats entry. */
export const AUTO_ORDER = ["spotify", "youtube", "soundcloud", "apple", "tidal", "amazon"];

export type View =
  | "home"
  | "search"
  | "liked"
  | "queue"
  | "services"
  | "settings"
  | "recent"
  | `pl:${string}`
  | `ar:${string}`;

/* The poll emits fresh objects every call — skip the setState (and the
   whole-tree re-render it costs) when nothing actually changed. */
export const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

export const RECENT_SEARCHES_KEY = "brw.recentSearches";
export const LAST_VIEW_KEY = "brw.lastView";

/* Spotify's "Browse all" grid on the empty search page — each tile
   seeds a provider query since we have no editorial catalog. */
export const CATEGORIES: { k: MsgKey; q: string; hue: number }[] = [
  { k: "brw.cat.charts", q: "top hits", hue: 262 },
  { k: "brw.cat.newReleases", q: "new releases", hue: 205 },
  { k: "brw.cat.latin", q: "latin hits", hue: 340 },
  { k: "brw.cat.mood", q: "mood", hue: 275 },
  { k: "brw.cat.workout", q: "workout", hue: 160 },
  { k: "brw.cat.party", q: "party", hue: 20 },
];

export const readLastView = (): View => {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY) ?? "";
    return /^(home|search|liked|queue|services|settings|recent|pl:|ar:)/.test(
      v,
    )
      ? (v as View)
      : "home";
  } catch {
    return "home";
  }
};

export type DlgState =
  | { kind: "save" }
  | { kind: "create" }
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string; name: string }
  | null;

export type CtxState = {
  x: number;
  y: number;
  kind: "pl" | "queue" | "railpl" | "pladd";
  index: number;
  path?: string;
  name?: string;
} | null;
