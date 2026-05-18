"use client";

import { createContext, useContext, useEffect, useState } from "react";
import en from "./translations/en";
import uk from "./translations/uk";

export type Locale = "en" | "uk";

const TRANSLATIONS = { en, uk } as const;

type Translations = typeof en;

// Dot-path accessor: t("nav.dashboard") → string
type DotPaths<T, Prefix extends string = ""> = {
  [K in keyof T]: T[K] extends string
    ? `${Prefix}${K & string}`
    : DotPaths<T[K], `${Prefix}${K & string}.`>;
}[keyof T];

export type TKey = DotPaths<Translations>;

function getNestedValue(obj: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return path;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : path;
}

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TKey) => string;
}

const Ctx = createContext<LocaleCtx>({
  locale: "en",
  setLocale: () => {},
  t: (k) => k,
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = localStorage.getItem("locale") as Locale | null;
    if (saved === "en" || saved === "uk") setLocaleState(saved);
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    localStorage.setItem("locale", l);
  }

  function t(key: TKey): string {
    return getNestedValue(
      TRANSLATIONS[locale] as unknown as Record<string, unknown>,
      key,
    );
  }

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useLocale() {
  return useContext(Ctx);
}

// Convenience — most components only need t()
export function useT() {
  return useContext(Ctx).t;
}
