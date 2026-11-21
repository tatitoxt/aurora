import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { bridge, subscribe, type QueueState, type Settings } from "./bridge";
import { openShare } from "./ShareCard";
import { THEMES } from "./themes";

interface Item {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Loose subsequence match; returns a score (higher is better) or -1. */
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    streak = at === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - (at - ti) * 0.01;
    ti = at + 1;
  }
  return score;
}

export const PALETTE_EVENT = "noctbeat:palette";
export function openPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

/** Ctrl/Cmd+K command palette: app commands plus every queued track. */
export default function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [queue, setQueue] = useState<QueueState>({ items: [], currentIndex: null });
  const [settings, setSettings] = useState<Settings | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onCustom = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onCustom);
    const offS = subscribe<Settings>("settings", setSettings);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onCustom);
      offS();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    void bridge.getQueue().then(setQueue).catch(() => {});
    void bridge.getSettings().then(setSettings).catch(() => {});
    inputRef.current?.focus();
  }, [open]);

  const patch = (p: Partial<Settings>) => {
    if (!settings) return;
    void bridge.updateSettings({ ...settings, ...p });
  };

  const close = () => setOpen(false);

  const items = useMemo<Item[]>(() => {
    const acts: Item[] = [
      { id: "play", label: "Play / Pause", hint: "media", run: () => void bridge.mediaControl("play-pause") },
      { id: "next", label: "Next track", hint: "media", run: () => void bridge.mediaControl("next") },
      { id: "prev", label: "Previous track", hint: "media", run: () => void bridge.mediaControl("previous") },
      {
        id: "seek-fwd",
        label: "Seek forward 10s",
        hint: "local",
        run: () =>
          void bridge.getNowPlaying().then((np) => bridge.seek(np.positionMs + 10_000)),
      },
      {
        id: "seek-back",
        label: "Seek back 10s",
        hint: "local",
        run: () =>
          void bridge
            .getNowPlaying()
            .then((np) => bridge.seek(Math.max(0, np.positionMs - 10_000))),
      },
      { id: "player", label: "Back to player", hint: "nav", run: () => nav("/") },
      // Share lives on the player route — the only place the card is mounted.
      ...(loc.pathname === "/"
        ? [{ id: "share", label: "Share now playing", hint: "card", run: () => openShare() }]
        : []),
      { id: "library", label: "Open library", hint: "nav", run: () => nav("/library") },
      { id: "stats", label: "Open listening stats", hint: "nav", run: () => nav("/stats") },
      { id: "wrapped", label: "Open monthly recap", hint: "nav", run: () => nav("/wrapped") },
      { id: "viz", label: "Open visualizer", hint: "nav", run: () => nav("/visualizer") },
      { id: "settings", label: "Open settings", hint: "nav", run: () => nav("/settings") },
      {
        id: "fullscreen",
        label: "Toggle fullscreen",
        hint: "window",
        run: () => void bridge.toggleFullscreen(),
      },
      {
        id: "rescan",
        label: "Rescan music folder",
        hint: "library",
        run: () => void bridge.scanLibrary(),
      },
      {
        id: "import",
        label: "Import playlist…",
        hint: "library",
        run: () =>
          void bridge
            .pickPlaylist()
            .then((p) => (p ? bridge.importPlaylist(p) : null)),
      },
      {
        id: "hud",
        label: "Toggle floating HUD",
        hint: "window",
        run: () => patch({ hudEnabled: !settings?.hudEnabled }),
      },
      {
        id: "dlyrics",
        label: "Toggle desktop lyrics",
        hint: "window",
        run: () => patch({ deskLyricsEnabled: !settings?.deskLyricsEnabled }),
      },
      {
        id: "lmode",
        label: "Lyrics mode: lines / karaoke",
        hint: "lyrics",
        run: () => patch({ lyricsMode: settings?.lyricsMode === "karaoke" ? "lines" : "karaoke" }),
      },
      {
        id: "video",
        label: "Toggle karaoke video backdrop",
        hint: "lyrics",
        run: () => patch({ videoBackdrop: !settings?.videoBackdrop }),
      },
      ...THEMES.map((t) => ({
        id: `theme-${t.name}`,
        label: `Theme: ${t.label}`,
        hint: "theme",
        run: () => patch({ theme: { ...settings!.theme, name: t.name } }),
      })),
    ];
    const tracks: Item[] = queue.items.map((it, i) => ({
      id: `q-${i}`,
      label: `Play "${it.track.title}"`,
      hint: it.track.artist,
      run: () => void bridge.playQueueIndex(i),
    }));
    const all = [...acts, ...tracks];
    // Cap the list here — keyboard selection must never reach a row the
    // user cannot see.
    if (!query.trim()) return all.slice(0, 40);
    return all
      .map((it) => ({ it, s: Math.max(fuzzy(query, it.label), fuzzy(query, it.hint ?? "") * 0.9) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it)
      .slice(0, 40);
  }, [query, queue, settings, nav, loc.pathname]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".palette__item--sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const runItem = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    it.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      // A focused result button fires its own click — running `sel` here
      // too would trigger the wrong row (or a toggle twice).
      if ((e.target as HTMLElement).closest("button")) return;
      runItem(sel);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Type a command or search tracks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette__list" ref={listRef}>
          {items.length === 0 && <div className="palette__empty">No matches</div>}
          {items.map((it, i) => (
            <button
              key={it.id}
              className={`palette__item ${i === sel ? "palette__item--sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onFocus={() => setSel(i)}
              onClick={() => runItem(i)}
              tabIndex={-1}
            >
              <span>{it.label}</span>
              {it.hint && <span className="palette__hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
