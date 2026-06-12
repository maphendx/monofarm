"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { API_URL, api, getToken } from "@/lib/api";
import { matchTokens } from "@/lib/search";
import { AuthImage } from "@/components/ui/AuthImage";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { SpecModal, type SpecModalProduct } from "@/components/warehouse/SpecModal";
import { FilterDropdown } from "@/components/warehouse/FilterDropdown";
import {
  useColumnVisibility,
  ColumnSettingsModal,
  TableSettingsButton,
  type ColDef,
} from "@/components/warehouse/TableSettings";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id: number; name: string; sku: string; categories: string[];
  unit: string; description: string | null; image_url: string | null;
  sale_price: string | null;
  cost_price: string | null; direct_cost: string | null; full_cost: string | null;
  min_stock: number | null; desired_stock: number | null; cell_limit: number | null;
};

type SpecSummary = {
  product_id: number;
  material_labels: string[];
  work_labels: string[];
  extra_labels: string[];
};

type SpecImportResult = {
  updated: number;
  skipped: number;
  errors: { sku: string; reason: string }[];
};

type SortKey = "name" | "sku" | "direct_cost" | "full_cost" | "sale_price" | "margin";
const PAGE_SIZES = [25, 50, 100] as const;

function Th({ col, sortKey, sortDir, onSort, children, className = "" }: {
  col: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (c: SortKey) => void; children: React.ReactNode; className?: string;
}) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`cursor-pointer select-none px-4 py-3 font-medium text-[var(--text-muted)] hover:text-[var(--text)] ${className}`}
    >
      <span className={`inline-flex items-center gap-1 ${className.includes("text-right") ? "justify-end" : ""}`}>
        {children}
        {active && <span className="text-[var(--accent)]">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );
}
type SortDir = "asc" | "desc";

// ── Column defs ───────────────────────────────────────────────────────────────

const COLS: ColDef[] = [
  { key: "name",       label: "Назва",        required: true },
  { key: "categories", label: "Категорії" },
  { key: "sku",        label: "SKU" },
  { key: "materials",  label: "Матеріали" },
  { key: "direct_cost", label: "Пряма собівартість" },
  { key: "full_cost",  label: "Повна собівартість" },
  { key: "works",      label: "Роботи" },
  { key: "extras",     label: "Дод. витрати" },
  { key: "unit",       label: "Од. виміру" },
  { key: "description", label: "Опис" },
  { key: "image",      label: "Фото" },
  { key: "sale_price", label: "Ціна" },
  { key: "margin",     label: "Маржа" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt2(v: string | null) {
  if (!v || parseFloat(v) === 0) return "—";
  return `${parseFloat(v).toFixed(2)} ₴`;
}

function calcMargin(sale: string | null, cost: string | null): number | null {
  if (!sale || !cost || parseFloat(sale) === 0) return null;
  return ((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100;
}

function firstItems(items: string[], limit = 2) {
  if (items.length === 0) return null;
  const visible = items.slice(0, limit).join(", ");
  return items.length > limit ? `${visible} +${items.length - limit}` : visible;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SpecsPage() {
  const [products,     setProducts]     = useState<Product[]>([]);
  const [specByProduct, setSpecByProduct] = useState<Record<number, SpecSummary>>({});
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [sortKey,      setSortKey]      = useState<SortKey>("name");
  const [sortDir,      setSortDir]      = useState<SortDir>("asc");
  const [filter,       setFilter]       = useState<"all" | "has" | "none">("all");
  const [pageSize,     setPageSize]     = useState<number>(25);
  const [page,         setPage]         = useState(1);
  const [importing,    setImporting]    = useState(false);
  const [importResult, setImportResult] = useState<SpecImportResult | null>(null);
  const [specProduct,  setSpecProduct]  = useState<SpecModalProduct | null>(null);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const colVis = useColumnVisibility("specs", COLS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const specsPromise = api<SpecSummary[]>("/api/warehouse/specs/defaults/summary").catch(() => [] as SpecSummary[]);
      const prods = await api<Product[]>("/api/warehouse/products");
      setProducts(prods);
      setSpecByProduct({});
      setLoading(false);
      const specs = await specsPromise;
      setSpecByProduct(Object.fromEntries(specs.map((spec) => [spec.product_id, spec])));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);
    setImportResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const result = await api<SpecImportResult>("/api/warehouse/specs/import", { method: "POST", body });
      setImportResult(result);
      await load();
    } catch {
      toast.error("Помилка імпорту специфікацій");
    } finally {
      setImporting(false);
    }
  }

  function handleExport() {
    const token = getToken();
    const url   = `${API_URL}/api/warehouse/specs/export`;
    const a     = document.createElement("a");
    a.href      = token ? `${url}?token=${token}` : url;

    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((blob) => {
        const href = URL.createObjectURL(blob);
        Object.assign(a, { href, download: "specs.tsv" });
        a.click();
        URL.revokeObjectURL(href);
      });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    const q = search.trim();
    return products.filter((p) => {
      const hasSpec = !!specByProduct[p.id];
      if (filter === "has"  && !hasSpec) return false;
      if (filter === "none" &&  hasSpec) return false;
      if (q && !matchTokens(`${p.name} ${p.sku} ${p.description ?? ""}`, q)) return false;
      return true;
    });
  }, [products, search, filter, specByProduct]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      if (sortKey === "name")            { av = a.name; bv = b.name; }
      else if (sortKey === "sku")        { av = a.sku;  bv = b.sku;  }
      else if (sortKey === "direct_cost") { av = parseFloat(a.direct_cost ?? "0"); bv = parseFloat(b.direct_cost ?? "0"); }
      else if (sortKey === "full_cost")  { av = parseFloat(a.full_cost  ?? "0"); bv = parseFloat(b.full_cost  ?? "0"); }
      else if (sortKey === "sale_price") { av = parseFloat(a.sale_price ?? "0"); bv = parseFloat(b.sale_price ?? "0"); }
      else if (sortKey === "margin") {
        av = calcMargin(a.sale_price, a.full_cost) ?? -999;
        bv = calcMargin(b.sale_price, b.full_cost) ?? -999;
      }
      const cmp = typeof av === "string" ? av.localeCompare(bv as string, "uk") : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize]);

  useEffect(() => { setPage(1); }, [search, filter, sortKey, sortDir, pageSize]);
  useEffect(() => { setPage((p) => Math.min(p, totalPages)); }, [totalPages]);

  const withSpec    = products.filter((p) => specByProduct[p.id]).length;
  const withoutSpec = products.length - withSpec;

  const colSpan = 1 + COLS.filter((c) => colVis.isVisible(c.key)).length;

  if (loading) return <PageSkeleton cols={13} />;

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Специфікації</h1>
          <p className="text-xs text-[var(--text-faint)]">
            {withSpec} з {products.length} позицій мають специфікацію
            {withoutSpec > 0 && ` · ${withoutSpec} без`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={importRef}
            type="file"
            accept=".xlsx,.tsv,.txt"
            className="hidden"
            onChange={handleImport}
          />
          <TableSettingsButton onClick={() => setColSettingsOpen(true)} />
          <button
            onClick={handleExport}
            className="btn btn-ghost btn-sm"
            title="Експорт TSV"
          >
            ↓ Експорт
          </button>
          <button
            onClick={() => importRef.current?.click()}
            disabled={importing}
            className="btn btn-ghost btn-sm disabled:opacity-50"
          >
            {importing ? "Імпортую…" : "↑ Імпорт"}
          </button>
        </div>
      </div>

      {/* ── Import result ── */}
      {importResult && (
        <div className="flex items-start gap-3 rounded-lg border border-[rgba(34,211,238,.25)] bg-[rgba(34,211,238,.06)] px-4 py-3">
          <div className="flex-1 text-sm">
            <span className="font-medium text-[var(--accent)]">
              Оновлено {importResult.updated} специфікацій
            </span>
            {importResult.skipped > 0 && (
              <span className="ml-2 text-[var(--text-muted)]">· пропущено {importResult.skipped}</span>
            )}
            {importResult.errors.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--text-faint)]">
                {importResult.errors.slice(0, 8).map((e) => (
                  <li key={e.sku}><span className="font-mono">{e.sku}</span> — {e.reason}</li>
                ))}
                {importResult.errors.length > 8 && <li>…ще {importResult.errors.length - 8}</li>}
              </ul>
            )}
          </div>
          <button
            onClick={() => setImportResult(null)}
            className="shrink-0 text-sm text-[var(--text-faint)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Filters / search ── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Назва або SKU…"
          className="w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm outline-none focus:border-[var(--border-strong)]"
        />
        <FilterDropdown active={filter !== "all" ? 1 : 0}>
          <div className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">Специфікація</p>
            <div className="space-y-0.5">
              {([["all", "Всі"], ["has", "Зі специфікацією"], ["none", "Без специфікації"]] as const).map(([val, label]) => (
                <label key={val} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--surface-hi)]">
                  <input
                    type="radio"
                    name="spec-filter"
                    checked={filter === val}
                    onChange={() => setFilter(val)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>
          </div>
          {filter !== "all" && (
            <div className="border-t border-[var(--border)] p-3">
              <button
                onClick={() => setFilter("all")}
                className="w-full rounded-md px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
              >
                Скинути фільтри
              </button>
            </div>
          )}
        </FilterDropdown>
        <span className="ml-auto text-xs text-[var(--text-faint)]">{sorted.length} позицій</span>
      </div>

      {/* ── Table ── */}
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg)] text-xs">
              <tr>
                {colVis.orderedCols.map((col) => {
                  if (!colVis.isVisible(col.key)) return null;
                  switch (col.key) {
                    case "image": return <th key="image" className="w-12 px-3 py-3" />;
                    case "name": return <Th key="name" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left">Назва</Th>;
                    case "categories": return <th key="categories" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Категорії</th>;
                    case "sku": return <Th key="sku" col="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left">SKU</Th>;
                    case "materials": return <th key="materials" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Матеріали</th>;
                    case "direct_cost": return <Th key="direct_cost" col="direct_cost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Пряма собівартість</Th>;
                    case "full_cost": return <Th key="full_cost" col="full_cost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Повна собівартість</Th>;
                    case "works": return <th key="works" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Роботи</th>;
                    case "extras": return <th key="extras" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Дод. витрати</th>;
                    case "unit": return <th key="unit" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Од. виміру</th>;
                    case "description": return <th key="description" className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Опис</th>;
                    case "sale_price": return <Th key="sale_price" col="sale_price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Ціна</Th>;
                    case "margin": return <Th key="margin" col="margin" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа</Th>;
                    default: return null;
                  }
                })}
                <th className="w-24 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {loading ? (
                <tr>
                  <td colSpan={colSpan + 1} className="px-4 py-10 text-center text-sm text-[var(--text-faint)]">
                    Завантаження…
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={colSpan + 1} className="px-4 py-10 text-center text-sm text-[var(--text-faint)]">
                    {search || filter !== "all" ? "Нічого не знайдено" : "Немає продуктів"}
                  </td>
                </tr>
              ) : (
                paginated.map((p) => {
                  const margin  = calcMargin(p.sale_price, p.full_cost);
                  const spec = specByProduct[p.id] ?? null;
                  const hasSpec = !!spec;
                  const materials = firstItems(spec?.material_labels ?? []);
                  const works = firstItems(spec?.work_labels ?? []);
                  const extras = firstItems(spec?.extra_labels ?? []);
                  return (
                    <tr key={p.id} className="group hover:bg-[var(--surface-hi)]">
                      {colVis.orderedCols.map((col) => {
                        if (!colVis.isVisible(col.key)) return null;
                        switch (col.key) {
                          case "image": return (
                            <td key="image" className="px-3 py-3">
                              {p.image_url ? (
                                <button
                                  onClick={() => setSpecProduct({ id: p.id, name: p.name, sku: p.sku, sale_price: p.sale_price })}
                                  className="block size-9 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-hi)]"
                                >
                                  <AuthImage src={p.image_url} alt={p.name} className="size-full object-cover" />
                                </button>
                              ) : (
                                <span className="text-[var(--text-faint)]">—</span>
                              )}
                            </td>
                          );
                          case "name": return (
                            <td key="name" className="px-4 py-3">
                              <button
                                onClick={() => setSpecProduct({ id: p.id, name: p.name, sku: p.sku, sale_price: p.sale_price })}
                                className="flex items-center gap-2 text-left font-medium hover:text-[var(--accent)]"
                              >
                                <span
                                  className={[
                                    "inline-block size-1.5 shrink-0 rounded-full",
                                    hasSpec ? "bg-[var(--state-ok)]" : "bg-[var(--border-strong)]",
                                  ].join(" ")}
                                  title={hasSpec ? "Специфікація є" : "Без специфікації"}
                                />
                                <span>{p.name}</span>
                              </button>
                            </td>
                          );
                          case "categories": return (
                            <td key="categories" className="px-4 py-3">
                              <div className="flex flex-wrap gap-1">
                                {p.categories.slice(0, 3).map((c) => (
                                  <span key={c} className="rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                                    {c}
                                  </span>
                                ))}
                                {p.categories.length > 3 && <span className="text-[10px] text-[var(--text-faint)]">+{p.categories.length - 3}</span>}
                                {p.categories.length === 0 && <span className="text-[var(--text-faint)]">—</span>}
                              </div>
                            </td>
                          );
                          case "sku": return <td key="sku" className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{p.sku}</td>;
                          case "materials": return <td key="materials" className="max-w-[260px] px-4 py-3 text-sm text-[var(--text-muted)]">{materials ?? <span className="text-[var(--text-faint)]">—</span>}</td>;
                          case "direct_cost": return (
                            <td key="direct_cost" className="px-4 py-3 text-right font-mono tabular-nums">
                              {p.direct_cost ? <span className="text-[var(--text-muted)]">{fmt2(p.direct_cost)}</span> : <span className="text-[var(--text-faint)]">—</span>}
                            </td>
                          );
                          case "full_cost": return (
                            <td key="full_cost" className="px-4 py-3 text-right font-mono tabular-nums">
                              {p.full_cost ? <span className="text-[var(--text-hi)]">{fmt2(p.full_cost)}</span> : <span className="text-[var(--text-faint)]">—</span>}
                            </td>
                          );
                          case "works": return <td key="works" className="max-w-[220px] px-4 py-3 text-sm text-[var(--text-muted)]">{works ?? <span className="text-[var(--text-faint)]">—</span>}</td>;
                          case "extras": return <td key="extras" className="max-w-[220px] px-4 py-3 text-sm text-[var(--text-muted)]">{extras ?? <span className="text-[var(--text-faint)]">—</span>}</td>;
                          case "unit": return <td key="unit" className="px-4 py-3 text-xs text-[var(--text-muted)]">{p.unit}</td>;
                          case "description": return (
                            <td key="description" className="max-w-[260px] px-4 py-3 text-sm text-[var(--text-muted)]">
                              {p.description ? <span className="line-clamp-2">{p.description}</span> : <span className="text-[var(--text-faint)]">—</span>}
                            </td>
                          );
                          case "sale_price": return <td key="sale_price" className="px-4 py-3 text-right font-mono tabular-nums text-[var(--text-muted)]">{fmt2(p.sale_price)}</td>;
                          case "margin": return (
                            <td key="margin" className="px-4 py-3 text-right">
                              {margin !== null ? (
                                <span className={[
                                  "font-mono tabular-nums text-xs font-medium",
                                  margin >= 50 ? "text-[var(--state-ok)]"
                                    : margin >= 20 ? "text-[var(--state-warn)]"
                                    : "text-[var(--state-error)]",
                                ].join(" ")}>
                                  {margin.toFixed(0)}%
                                </span>
                              ) : (
                                <span className="text-[var(--text-faint)]">—</span>
                              )}
                            </td>
                          );
                          default: return null;
                        }
                      })}
                      <td className="px-4 py-3 text-right">
                        <div className="invisible flex items-center justify-end gap-1 group-hover:visible">
                          <button
                            onClick={() => setSpecProduct({ id: p.id, name: p.name, sku: p.sku, sale_price: p.sale_price })}
                            className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                          >
                            {hasSpec ? "Редагувати" : "+ Специфікація"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {sorted.length > 0 && (
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <span>Рядків:</span>
              {PAGE_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setPageSize(s)}
                  className={[
                    "rounded px-2 py-0.5 text-sm",
                    pageSize === s ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--surface-hi)]",
                  ].join(" ")}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-2 text-sm text-[var(--text-faint)]">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} з {sorted.length}
              </span>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30"
              >
                ‹
              </button>
              {totalPages <= 7 && Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={[
                    "flex size-7 items-center justify-center rounded-md text-sm",
                    page === p ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                  ].join(" ")}
                >
                  {p}
                </button>
              ))}
              {totalPages > 7 && <span className="px-1 text-sm text-[var(--text-faint)]">{page} / {totalPages}</span>}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-30"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>

      {specProduct && (
        <SpecModal
          product={specProduct}
          onClose={() => { setSpecProduct(null); load(); }}
        />
      )}

      <ColumnSettingsModal
        open={colSettingsOpen}
        onClose={() => setColSettingsOpen(false)}
        cols={colVis.cols}
        hidden={colVis.hidden}
        setVisibility={colVis.setVisibility}
        orderedCols={colVis.orderedCols}
        setOrder={colVis.setOrder}
      />
    </div>
  );
}
