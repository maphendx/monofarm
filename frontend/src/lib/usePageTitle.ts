"use client";

import { useEffect } from "react";

import { useT } from "./i18n";
import type { TKey } from "./i18n";

export function usePageTitle(key: TKey) {
  const t = useT();
  const label = t(key);
  useEffect(() => {
    document.title = `monofarm | ${label}`;
    return () => { document.title = "monofarm"; };
  }, [label]);
}
