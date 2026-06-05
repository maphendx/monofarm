"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function readTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("monofarm_theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const t = readTheme();
    setTheme(t);
    applyTheme(t);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    localStorage.setItem("monofarm_theme", next);
  }

  if (compact) {
    return (
      <button
        onClick={toggle}
        className="flex size-[18px] shrink-0 items-center justify-center text-[var(--text-muted)] transition hover:text-[var(--text-hi)]  "
        aria-label={theme === "dark" ? "Світла тема" : "Темна тема"}
        title={theme === "dark" ? "Світла тема" : "Темна тема"}
      >
        {theme === "dark" ? <Sun size={15} strokeWidth={1.7} /> : <Moon size={15} strokeWidth={1.7} />}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      className="rounded-md border border-[var(--border)] p-1.5 text-[var(--text)] transition hover:bg-[var(--surface-hi)]   "
      aria-label={theme === "dark" ? "Світла тема" : "Темна тема"}
      title={theme === "dark" ? "Світла тема" : "Темна тема"}
    >
      {theme === "dark" ? <Sun size={15} strokeWidth={1.7} /> : <Moon size={15} strokeWidth={1.7} />}
    </button>
  );
}
