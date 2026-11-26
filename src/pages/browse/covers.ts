import { useEffect, useState } from "react";

/** Custom playlist covers: user-picked images resized to a 256px JPEG
    data URL in localStorage, keyed by playlist path. Deliberately not
    in the .m3u — covers are presentation, not playlist content, and
    this survives both the Tauri webview and the browser preview. */
const KEY = "noctbeat-plcovers";

function readAll(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function playlistCover(path: string): string | null {
  return readAll()[path] ?? null;
}

export function allPlaylistCovers(): Record<string, string> {
  return readAll();
}

export function setPlaylistCover(path: string, dataUrl: string | null) {
  const all = readAll();
  if (dataUrl) all[path] = dataUrl;
  else delete all[path];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota — covers are best-effort */
  }
  window.dispatchEvent(new CustomEvent("noctbeat-plcovers"));
}

/** Move a cover across a playlist rename; deleting the old key prevents
   a future unrelated playlist at that path from inheriting the image. */
export function renamePlaylistCover(from: string, to: string) {
  if (from === to) return;
  const all = readAll();
  const cover = all[from];
  if (!cover) return;
  delete all[from];
  all[to] = cover;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota — covers are best-effort */
  }
  window.dispatchEvent(new CustomEvent("noctbeat-plcovers"));
}

/** Resize a picked image file to a square-ish JPEG data URL. */
export function fileToCoverDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = 256;
      const cv = document.createElement("canvas");
      cv.width = s;
      cv.height = s;
      const cx = cv.getContext("2d");
      if (!cx) return reject(new Error("no canvas"));
      /* Center-crop to square like a cover tile. */
      const side = Math.min(img.width, img.height);
      cx.drawImage(
        img,
        (img.width - side) / 2,
        (img.height - side) / 2,
        side,
        side,
        0,
        0,
        s,
        s,
      );
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable image"));
    };
    img.src = url;
  });
}

/** Hidden input helper: resolves with the picked file or null. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    /* Cancel doesn't fire reliably everywhere; focus back on the
       window after the picker closes is close enough. */
    inp.click();
  });
}

/** Reactive map of path → cover data URL; re-reads on every change. */
export function usePlaylistCovers(): Record<string, string> {
  const [covers, setCovers] = useState(readAll);
  useEffect(() => {
    const h = () => setCovers(readAll());
    window.addEventListener("noctbeat-plcovers", h);
    return () => window.removeEventListener("noctbeat-plcovers", h);
  }, []);
  return covers;
}
