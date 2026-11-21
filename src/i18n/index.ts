import { useCallback, useEffect, useState } from "react";
import { bridge, subscribe, type Settings } from "../bridge";
import en from "./en";
import es from "./es";
import pt from "./pt";
import fr from "./fr";
import de from "./de";
import it from "./it";
import ja from "./ja";
import zh from "./zh";
import ko from "./ko";

export const LOCALES = { en, es, pt, fr, de, it, ja, zh, ko };
export type Lang = keyof typeof LOCALES;
export type MsgKey = keyof typeof en;

/** Shown in the language picker, in each locale's own name. */
export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Español",
  pt: "Português",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ja: "\u65e5\u672c\u8a9e",
  zh: "\u4e2d\u6587",
  ko: "\ud55c\uad6d\uc5b4",
};

const dicts: Record<string, Record<string, string>> = LOCALES;

/** Look up a message; falls back to English, then to the key itself.
 * `{name}` placeholders are filled from `vars`. */
export function t(lang: string | null | undefined, key: MsgKey, vars?: Record<string, string | number>): string {
  let s = dicts[lang ?? "en"]?.[key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Reactive translator: reads settings.language once and follows the
 * settings event so the UI switches language live. */
export function useT() {
  const [lang, setLang] = useState("en");
  useEffect(() => {
    void bridge.getSettings().then((s) => setLang(s.language));
    return subscribe<Settings>("settings", (s) => setLang(s.language));
  }, []);
  return useCallback((key: MsgKey, vars?: Record<string, string | number>) => t(lang, key, vars), [lang]);
}
