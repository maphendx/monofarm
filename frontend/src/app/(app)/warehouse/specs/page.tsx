"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { API_URL, api, getToken } from "@/lib/api";
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
  unit: string; sale_price: string | null;
  cost_price: string | null; direct_cost: string | null; full_cost: string | null;
  min_stock: number | null; desired_stock: number | null; cell_limit: number | null;
};

type SpecImportResult = {
  updated: number;
  skipped: number;
  errors: { sku: string; reason: string }[];
};

type SortKey = "name" | "sku" | "full_cost" | "sale_price" | "margin";

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
  { key: "sku",        label: "SKU" },
  { key: "categories", label: "Категорії" },
  { key: "full_cost",  label: "Собівартість" },
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SpecsPage() {
  const [products,     setProducts]     = useState<Product[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [sortKey,      setSortKey]      = useState<SortKey>("name");
  const [sortDir,      setSortDir]      = useState<SortDir>("asc");
  const [filter,       setFilter]       = useState<"all" | "has" | "none">("all");
  const [importing,    setImporting]    = useState(false);
  const [importResult, setImportResult] = useState<SpecImportResult | null>(null);
  const [specProduct,  setSpecProduct]  = useState<SpecModalProduct | null>(null);
  const [colSettingsOpen, setColSettingsOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const colVis = useColumnVisibility("specs", COLS);

  const load = useCallback(async () => {
    try {
      const prods = await api<Product[]>("/api/warehouse/products");
      setProducts(prods);
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
    const q = search.toLowerCase();
    return products.filter((p) => {
      if (filter === "has"  && !p.full_cost) return false;
      if (filter === "none" &&  p.full_cost) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, filter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      if (sortKey === "name")            { av = a.name; bv = b.name; }
      else if (sortKey === "sku")        { av = a.sku;  bv = b.sku;  }
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

  const withSpec    = products.filter((p) => p.full_cost).length;
  const withoutSpec = products.length - withSpec;

  const colSpan = 1 + COLS.filter((c) => colVis.isVisible(c.key)).length;

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
                <Th col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left">Назва</Th>
                {colVis.isVisible("sku")        && <Th col="sku"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-left">SKU</Th>}
                {colVis.isVisible("categories") && <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Категорії</th>}
                {colVis.isVisible("full_cost")  && <Th col="full_cost"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Собівартість</Th>}
                {colVis.isVisible("sale_price") && <Th col="sale_price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Ціна</Th>}
                {colVis.isVisible("margin")     && <Th col="margin"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа</Th>}
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
                sorted.map((p) => {
                  const margin  = calcMargin(p.sale_price, p.full_cost);
                  const hasSpec = !!p.full_cost;
                  return (
                    <tr key={p.id} className="group hover:bg-[var(--surface-hi)]">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={[
                              "inline-block size-1.5 shrink-0 rounded-full",
                              hasSpec ? "bg-[var(--state-ok)]" : "bg-[var(--border-strong)]",
                            ].join(" ")}
                            title={hasSpec ? "Специфікація є" : "Без специфікації"}
                          />
                          <span className="font-medium">{p.name}</span>
                        </div>
                      </td>
                      {colVis.isVisible("sku") && (
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">{p.sku}</td>
                      )}
                      {colVis.isVisible("categories") && (
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {p.categories.slice(0, 3).map((c) => (
                              <span key={c}
                                className="rounded-full bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                                {c}
                              </span>
                            ))}
                            {p.categories.length > 3 && (
                              <span className="text-[10px] text-[var(--text-faint)]">+{p.categories.length - 3}</span>
                            )}
                          </div>
                        </td>
                      )}
                      {colVis.isVisible("full_cost") && (
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {hasSpec ? (
                            <span className="text-[var(--text-hi)]">{fmt2(p.full_cost)}</span>
                          ) : (
                            <span className="text-[var(--text-faint)]">—</span>
                          )}
                        </td>
                      )}
                      {colVis.isVisible("sale_price") && (
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-[var(--text-muted)]">
                          {fmt2(p.sale_price)}
                        </td>
                      )}
                      {colVis.isVisible("margin") && (
                        <td className="px-4 py-3 text-right">
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
                      )}
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
