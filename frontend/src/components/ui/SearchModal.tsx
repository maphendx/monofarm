"use client";

import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

type PageItem     = { kind: "page";     href: string; label: string; section: string };
type ProductItem  = { kind: "product";  id: number; name: string; sku: string; barcode: string | null; href: string };
type FilamentItem = { kind: "filament"; id: number; label: string; brand: string | null; sku: string | null; label_id: string | null; href: string };
type FileItem     = { kind: "file";     id: number; name: string; href: string };
type PrinterItem  = { kind: "printer";  id: number; name: string; kind_label: string; href: string };
type AnyItem      = PageItem | ProductItem | FilamentItem | FileItem | PrinterItem;

const PAGES: PageItem[] = [
  { href: "/dashboard",                label: "Дашборд",          section: "Головне",      kind: "page" },
  { href: "/plan",                      label: "Планування",       section: "Головне",      kind: "page" },
  { href: "/tasks",                     label: "Завдання",         section: "Головне",      kind: "page" },
  { href: "/files",                     label: "Файли",            section: "Головне",      kind: "page" },
  { href: "/analytics",                 label: "Аналітика",        section: "Аналіз",       kind: "page" },
  { href: "/history",                   label: "Історія",          section: "Аналіз",       kind: "page" },
  { href: "/filament",                  label: "Матеріали",        section: "Управління",   kind: "page" },
  { href: "/warehouse",                 label: "Склад",            section: "Управління",   kind: "page" },
  { href: "/warehouse/products",        label: "Товари",           section: "Склад",        kind: "page" },
  { href: "/warehouse/products",        label: "Номенклатура",     section: "Склад",        kind: "page" },
  { href: "/warehouse/stock",           label: "Залишки",          section: "Склад",        kind: "page" },
  { href: "/warehouse/orders",          label: "Замовлення",       section: "Склад",        kind: "page" },
  { href: "/warehouse/production",      label: "Виробництво",      section: "Склад",        kind: "page" },
  { href: "/warehouse/movements",       label: "Рухи",             section: "Склад",        kind: "page" },
  { href: "/warehouse/cashflow",        label: "Грошовий потік",   section: "Склад",        kind: "page" },
  { href: "/warehouse/analytics",       label: "Аналітика складу", section: "Склад",        kind: "page" },
  { href: "/warehouse/specs",           label: "Специфікації",     section: "Склад",        kind: "page" },
  { href: "/warehouse/categories",      label: "Категорії",        section: "Склад",        kind: "page" },
  { href: "/warehouse/counterparties",  label: "Контрагенти",      section: "Склад",        kind: "page" },
  { href: "/warehouse/warehouses",      label: "Склади",           section: "Склад",        kind: "page" },
  { href: "/users",                     label: "Користувачі",      section: "Управління",   kind: "page" },
  { href: "/settings",                  label: "Налаштування",     section: "Налаштування", kind: "page" },
];

const PRINTER_KIND_LABEL: Record<string, string> = {
  snapmaker_u1: "Snapmaker U1",
  bambu:        "Bambu Lab",
  other:        "Принтер",
};

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
  const map: Record<AnyItem["kind"], [string, string]> = {
    page:     ["Сторінка", "text-[var(--text-faint)]"],
    product:  ["Товар",    "text-[var(--accent)]"],
    filament: ["Котушка",  "text-[var(--text-muted)]"],
    file:     ["Файл",     "text-[var(--state-print)]"],
    printer:  ["Принтер",  "text-[var(--state-ok)]"],
  };
  const [label, cls] = map[kind];
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-hi)] shrink-0 ${cls}`}>
      {label}
    </span>
  );
}

function itemLabel(item: AnyItem): string {
  if (item.kind === "page")     return item.label;
  if (item.kind === "product")  return item.name;
  if (item.kind === "filament") return item.label;
  if (item.kind === "file")     return item.name;
  return item.name;
}

function itemMeta(item: AnyItem): string {
  if (item.kind === "page")     return item.section;
  if (item.kind === "product")  return [item.sku, item.barcode].filter(Boolean).join(" · ");
  if (item.kind === "filament") return [item.brand, item.sku, item.label_id ? `#${item.label_id}` : null].filter(Boolean).join(" · ");
  if (item.kind === "file")     return "Файли";
  return item.kind_label;
}

type ApiResult = {
  products:  Omit<ProductItem,  "kind">[];
  filaments: Omit<FilamentItem, "kind">[];
  files:     Omit<FileItem,     "kind">[];
  printers:  Array<{ id: number; name: string; kind: string; href: string }>;
};

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery]     = useState("");
  const [idx, setIdx]         = useState(0);
  const [liveItems, setLive]  = useState<AnyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const router                = useRouter();
  const inputRef              = useRef<HTMLInputElement>(null);
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIdx(0); }, [query, liveItems]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) { setLive([]); setLoading(false); return; }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api<ApiResult>(`/api/search?q=${encodeURIComponent(q)}`);
        const products:  ProductItem[]  = data.products.map((p) => ({ ...p, kind: "product" }));
        const filaments: FilamentItem[] = data.filaments.map((f) => ({ ...f, kind: "filament" }));
        const files:     FileItem[]     = data.files.map((f) => ({ ...f, kind: "file" }));
        const printers:  PrinterItem[]  = data.printers.map((p) => ({
          id: p.id, name: p.name, kind_label: PRINTER_KIND_LABEL[p.kind] ?? "Принтер", href: p.href, kind: "printer",
        }));
        setLive([...printers, ...products, ...files, ...filaments]);
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
  const results: AnyItem[]     = q.length >= 2 ? [...liveItems, ...pageResults] : pageResults;

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
            <Loader2 size={15} strokeWidth={1.7} className="shrink-0 text-[var(--accent)] animate-spin" />
          ) : (
            <Search size={15} strokeWidth={1.7} className="shrink-0 text-[var(--text-faint)]" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Пошук сторінок, товарів, файлів, принтерів…"
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
                <span className="text-xs text-[var(--text-faint)] truncate max-w-[140px]">{itemMeta(item)}</span>
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
