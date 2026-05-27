"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { href: string; label: string; section: string };

const ALL: Item[] = [
  { href: "/dashboard",            label: "Дашборд",          section: "Головне" },
  { href: "/plan",                  label: "Планування",       section: "Головне" },
  { href: "/tasks",                 label: "Завдання",         section: "Головне" },
  { href: "/files",                 label: "Файли",            section: "Головне" },
  { href: "/analytics",             label: "Аналітика",        section: "Аналіз" },
  { href: "/history",               label: "Історія",          section: "Аналіз" },
  { href: "/filament",              label: "Філамент",         section: "Управління" },
  { href: "/warehouse",             label: "Склад",            section: "Управління" },
  { href: "/warehouse/products",    label: "Товари",           section: "Склад" },
  { href: "/warehouse/stock",       label: "Залишки",          section: "Склад" },
  { href: "/warehouse/orders",      label: "Замовлення",       section: "Склад" },
  { href: "/warehouse/movements",   label: "Рухи",             section: "Склад" },
  { href: "/warehouse/production",  label: "Виробництво",      section: "Склад" },
  { href: "/warehouse/cashflow",    label: "Грошовий потік",   section: "Склад" },
  { href: "/warehouse/analytics",   label: "Аналітика складу", section: "Склад" },
  { href: "/users",                 label: "Користувачі",      section: "Управління" },
  { href: "/settings",              label: "Налаштування",     section: "Налаштування" },
];

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [idx, setIdx]     = useState(0);
  const router            = useRouter();
  const inputRef          = useRef<HTMLInputElement>(null);

  const results = query.trim()
    ? ALL.filter((i) =>
        i.label.toLowerCase().includes(query.toLowerCase()) ||
        i.section.toLowerCase().includes(query.toLowerCase()) ||
        i.href.includes(query.toLowerCase())
      )
    : ALL;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIdx(0); }, [query]);

  function go(href: string) { router.push(href); onClose(); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown")  { e.preventDefault(); setIdx((v) => Math.min(v + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((v) => Math.max(v - 1, 0)); }
    else if (e.key === "Enter")   { if (results[idx]) go(results[idx].href); }
    else if (e.key === "Escape")  { onClose(); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-[540px] mx-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Пошук сторінок..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
          />
          <kbd className="text-[10px] text-[var(--text-faint)] border border-[var(--border)] rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[320px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : (
            results.map((item, i) => (
              <button
                key={item.href}
                onClick={() => go(item.href)}
                onMouseEnter={() => setIdx(i)}
                className={[
                  "flex w-full items-center gap-3 px-4 py-2 text-sm text-left transition-colors",
                  i === idx ? "bg-[var(--surface-hi)]" : "",
                ].join(" ")}
              >
                <span className="flex-1 text-[var(--text)]">{item.label}</span>
                <span className="text-xs text-[var(--text-faint)]">{item.section}</span>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-[var(--border)] px-4 py-2 flex items-center gap-4 text-[10px] text-[var(--text-faint)]">
          <span><kbd className="border border-[var(--border)] rounded px-1 py-0.5">↑↓</kbd> навігація</span>
          <span><kbd className="border border-[var(--border)] rounded px-1 py-0.5">↵</kbd> відкрити</span>
          <span><kbd className="border border-[var(--border)] rounded px-1 py-0.5">esc</kbd> закрити</span>
        </div>
      </div>
    </div>
  );
}
