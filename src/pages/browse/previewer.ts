/** 30s catalog previews: one shared audio element, plays the preview
    URL a catalog entry carries (iTunes supplies them). Independent of
    the engine — it's a sample, not playback. */
import { useEffect, useState } from "react";

let audio: HTMLAudioElement | null = null;
let current: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.addEventListener("ended", () => {
      current = null;
      emit();
    });
  }
  return audio;
}

export function togglePreview(url: string, volume = 0.6) {
  const a = ensureAudio();
  if (current === url) {
    a.pause();
    current = null;
  } else {
    a.src = url;
    a.volume = volume;
    void a.play().catch(() => {
      current = null;
    });
    current = url;
  }
  emit();
}

export function stopPreview() {
  if (audio) audio.pause();
  current = null;
  emit();
}

export function previewingUrl(): string | null {
  return current;
}

/** React hook: which preview URL is playing right now (null = none). */
export function usePreviewing(): string | null {
  const [cur, setCur] = useState(current);
  useEffect(() => {
    const cb = () => setCur(current);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return cur;
}
