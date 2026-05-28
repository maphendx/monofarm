"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

type PageItem = { href: string; label: string; section: string; kind: "page" };
type ProductItem = { id: number; name: string; sku: string; barcode: string | null; href: string; kind: "product" };
type FilamentItem = { id: number; label: string; brand: string | null; sku: string | null; label_id: string | null; href: string; kind: "filament" };
type AnyItem = PageItem | ProductItem | FilamentItem;

const PAGES: PageItem[] = [
  { href: "/dashboard",            label: "Дашборд",          section: "Головне",      kind: "page" },
  { href: "/plan",                  label: "Планування",       section: "Головне",      kind: "page" },
  { href: "/tasks",                 label: "Завдання",         section: "Головне",      kind: "page" },
  { href: "/files",                 label: "Файли",            section: "Головне",      kind: "page" },
  { href: "/analytics",             label: "Аналітика",        section: "Аналіз",       kind: "page" },
  { href: "/history",               label: "Історія",          section: "Аналіз",       kind: "page" },
  { href: "/filament",              label: "Матеріали",        section: "Управління",   kind: "page" },
  { href: "/warehouse",             label: "Склад",            section: "Управління",   kind: "page" },
  { href: "/warehouse/products",    label: "Товари",           section: "Склад",        kind: "page" },
  { href: "/warehouse/stock",       label: "Залишки",          section: "Склад",        kind: "page" },
  { href: "/warehouse/orders",      label: "Замовлення",       section: "Склад",        kind: "page" },
  { href: "/warehouse/movements",   label: "Рухи",             section: "Склад",        kind: "page" },
  { href: "/warehouse/production",  label: "Виробництво",      section: "Склад",        kind: "page" },
  { href: "/warehouse/cashflow",    label: "Грошовий потік",   section: "Склад",        kind: "page" },
  { href: "/warehouse/analytics",   label: "Аналітика складу", section: "Склад",        kind: "page" },
  { href: "/warehouse/specs",       label: "Специфікації",     section: "Склад",        kind: "page" },
  { href: "/warehouse/categories",  label: "Категорії",        section: "Склад",        kind: "page" },
  { href: "/warehouse/counterparties", label: "Контрагенти",  section: "Склад",        kind: "page" },
  { href: "/warehouse/warehouses",  label: "Склади",           section: "Склад",        kind: "page" },
  { href: "/users",                 label: "Користувачі",      section: "Управління",   kind: "page" },
  { href: "/settings",              label: "Налаштування",     section: "Налаштування", kind: "page" },
];

function matchPages(q: string): PageItem[] {
  const lower = q.toLowerCase();
  return PAGES.filter(
    (i) =>
      i.label.toLowerCase().includes(lower) ||
      i.section.toLowerCase().includes(lower) ||
      i.href.includes(lower),
  );
}

function KindBadge({ kind }: { kind: AnyItem["kind"] }) {
  if (kind === "page")     return <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-hi)] text-[var(--text-faint)]">Сторінка</span>;
  if (kind === "product")  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-hi)] text-[var(--accent)]">Товар</span>;
  if (kind === "filament") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-hi)] text-[var(--text-muted)]">Котушка</span>;
  return null;
}

function itemLabel(item: AnyItem): string {
  if (item.kind === "page") return item.label;
  if (item.kind === "product") return item.name;
  return item.label;
}

function itemMeta(item: AnyItem): string {
  if (item.kind === "page") return item.section;
  if (item.kind === "product") {
    const parts = [item.sku];
    if (item.barcode) parts.push(item.barcode);
    return parts.join(" · ");
  }
  // filament
  const parts: string[] = [];
  if (item.brand) parts.push(item.brand);
  if (item.sku) parts.push(item.sku);
  if (item.label_id) parts.push(`#${item.label_id}`);
  return parts.join(" · ");
}

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery]       = useState("");
  const [idx, setIdx]           = useState(0);
  const [liveItems, setLive]    = useState<AnyItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const router                  = useRouter();
  const inputRef                = useRef<HTMLInputElement>(null);
  const debounceRef             = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIdx(0); }, [query, liveItems]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 2) {
      setLive([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api<{ products: Omit<ProductItem, "kind">[]; filaments: Omit<FilamentItem, "kind">[] }>(
          `/search?q=${encodeURIComponent(q)}`,
        );
        const products: ProductItem[] = data.products.map((p) => ({ ...p, kind: "product" }));
        const filaments: FilamentItem[] = data.filaments.map((f) => ({ ...f, kind: "filament" }));
        setLive([...products, ...filaments]);
      } catch {
        setLive([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const q = query.trim();
  const pageResults: AnyItem[] = q.length >= 1 ? matchPages(q) : PAGES;
  const results: AnyItem[] = q.length >= 2 ? [...liveItems, ...pageResults] : pageResults;

  function go(href: string) { router.push(href); onClose(); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown")  { e.preventDefault(); setIdx((v) => Math.min(v + 1, results.length - 1)); }
    else if (e.key === "ArrowUp")  { e.preventDefault(); setIdx((v) => Math.max(v - 1, 0)); }
    else if (e.key === "Enter")    { if (results[idx]) go(results[idx].href); }
    else if (e.key === "Escape")   { onClose(); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-[560px] mx-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          {loading ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--accent)] animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-faint)]">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Пошук сторінок, товарів, котушок…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-faint)]"
          />
          <kbd className="text-[10px] text-[var(--text-faint)] border border-[var(--border)] rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[380px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : (
            results.map((item, i) => (
              <button
                key={`${item.kind}-${item.href}-${i}`}
                onClick={() => go(item.href)}
                onMouseEnter={() => setIdx(i)}
                className={[
                  "flex w-full items-center gap-3 px-4 py-2 text-sm text-left transition-colors",
                  i === idx ? "bg-[var(--surface-hi)]" : "",
                ].join(" ")}
              >
                <span className="flex-1 truncate text-[var(--text)]">{itemLabel(item)}</span>
                <span className="shrink-0 text-xs text-[var(--text-faint)] truncate max-w-[140px]">{itemMeta(item)}</span>
                <KindBadge kind={item.kind} />
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
