"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Product = {
  id:          number;
  name:        string;
  sku:         string;
  categories:  string[];
  unit:        string;
  sale_price:  string | null;
  direct_cost: string | null;
  full_cost:   string | null;
  is_active:   boolean;
};

type StockEntry = { product_id: number; available: string };

type SortKey = "name" | "sku" | "stock" | "full_cost" | "sale_price" | "margin";
type SortDir = "asc" | "desc";

const PAGE_SIZES = [25, 50, 100] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: string | null) {
  if (!v || parseFloat(v) === 0) return "—";
  return `${parseFloat(v).toFixed(2)} ₴`;
}

function calcMargin(sale: string | null, cost: string | null): number | null {
  if (!sale || !cost || parseFloat(sale) === 0) return null;
  return ((parseFloat(sale) - parseFloat(cost)) / parseFloat(sale)) * 100;
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIndicator({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) {
    return <span className="ml-1 text-neutral-300 dark:text-neutral-700">↕</span>;
  }
  return <span className="ml-1 text-cyan-500">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

// ── Th helper ─────────────────────────────────────────────────────────────────

function Th({
  col, sortKey, sortDir, onSort, children, className = "",
}: {
  col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onSort: (c: SortKey) => void;
  children: React.ReactNode; className?: string;
}) {
  return (
    <th
      onClick={() => onSort(col)}
      className={`cursor-pointer select-none px-4 py-3 font-medium hover:text-neutral-800 dark:hover:text-neutral-200 ${className}`}
    >
      {children}
      <SortIndicator col={col} sortKey={sortKey} sortDir={sortDir} />
    </th>
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (p: Product) => void;
}) {
  const [name, setName]  = useState("");
  const [sku,  setSku]   = useState("");
  const [unit, setUnit]  = useState("шт");
  const [cats, setCats]  = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy]  = useState(false);
  const [err,  setErr]   = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(""); setSku(""); setUnit("шт"); setCats(""); setPrice(""); setErr(null); }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const p = await api<Product>("/api/warehouse/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          sku:  sku.trim(),
          unit: unit.trim() || "шт",
          categories: cats.split(",").map((c) => c.trim()).filter(Boolean),
          sale_price:  price ? parseFloat(price) : null,
        }),
      });
      onCreated(p);
      onClose();
    } catch {
      setErr("Помилка збереження. Перевірте поля.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 font-semibold">Нова номенклатура</h2>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Назва *</span>
            <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Артикул (SKU) *</span>
              <input required value={sku} onChange={(e) => setSku(e.target.value)}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Одиниця</span>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="шт"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Категорії (через кому)</span>
            <input value={cats} onChange={(e) => setCats(e.target.value)} placeholder="Іграшки, Keychain"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Роздрібна ціна (₴)</span>
            <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
          </label>
          {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
              Скасувати
            </button>
            <button type="submit" disabled={busy || !name.trim() || !sku.trim()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
              {busy ? "Зберігаю…" : "Додати"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [stock,    setStock]    = useState<StockEntry[]>([]);
  const [loading,  setLoading]  = useState(true);

  // Filters
  const [search,   setSearch]   = useState("");
  const [category, setCategory] = useState("Всі");

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Pagination
  const [pageSize, setPageSize] = useState<number>(25);
  const [page,     setPage]     = useState(1);

  // Bulk selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [prods, stk] = await Promise.all([
        api<Product[]>("/api/warehouse/products"),
        api<StockEntry[]>("/api/warehouse/stock"),
      ]);
      setProducts(prods);
      setStock(stk);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Aggregate available stock per product across all warehouses
  const stockByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of stock) {
      map.set(s.product_id, (map.get(s.product_id) ?? 0) + parseFloat(s.available));
    }
    return map;
  }, [stock]);

  const allCategories = useMemo(
    () => ["Всі", ...Array.from(new Set(products.flatMap((p) => p.categories))).sort()],
    [products],
  );

  // Filter
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter((p) => {
      if (category !== "Всі" && !p.categories.includes(category)) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, category]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av = 0, bv = 0;
      switch (sortKey) {
        case "name":      return sortDir === "asc" ? a.name.localeCompare(b.name, "uk") : b.name.localeCompare(a.name, "uk");
        case "sku":       return sortDir === "asc" ? a.sku.localeCompare(b.sku) : b.sku.localeCompare(a.sku);
        case "stock":     av = stockByProduct.get(a.id) ?? 0; bv = stockByProduct.get(b.id) ?? 0; break;
        case "full_cost": av = parseFloat(a.full_cost ?? "0"); bv = parseFloat(b.full_cost ?? "0"); break;
        case "sale_price":av = parseFloat(a.sale_price ?? "0"); bv = parseFloat(b.sale_price ?? "0"); break;
        case "margin": {
          const am = calcMargin(a.sale_price, a.full_cost); av = am ?? -Infinity;
          const bm = calcMargin(b.sale_price, b.full_cost); bv = bm ?? -Infinity;
          break;
        }
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [filtered, sortKey, sortDir, stockByProduct]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated  = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize]);

  // Reset page on filter/sort change
  useEffect(() => { setPage(1); }, [search, category, sortKey, sortDir, pageSize]);

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(col); setSortDir("asc"); }
  }

  // Selection helpers
  const allPageSelected = paginated.length > 0 && paginated.every((p) => selected.has(p.id));

  function toggleAll() {
    if (allPageSelected) {
      setSelected((prev) => { const next = new Set(prev); paginated.forEach((p) => next.delete(p.id)); return next; });
    } else {
      setSelected((prev) => { const next = new Set(prev); paginated.forEach((p) => next.add(p.id)); return next; });
    }
  }

  function toggleOne(id: number) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  async function deleteSelected() {
    if (!window.confirm(`Деактивувати ${selected.size} позицій?`)) return;
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => api(`/api/warehouse/products/${id}`, { method: "DELETE" })));
      setProducts((prev) => prev.filter((p) => !selected.has(p.id)));
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <div className="space-y-4">

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="search" placeholder="Назва або артикул…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="h-9 rounded-lg border border-neutral-200 bg-white pl-8 pr-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:focus:border-neutral-600"
            />
          </div>

          {/* Category filter */}
          <select
            value={category} onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
          >
            {allCategories.map((c) => <option key={c}>{c}</option>)}
          </select>

          {/* Counter */}
          <span className="text-sm text-neutral-400">
            {filtered.length} позицій
          </span>
        </div>

        <button
          onClick={() => setCreateOpen(true)}
          className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          + Номенклатура
        </button>
      </div>

      {/* ── Bulk action bar ────────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-800/50 dark:bg-amber-950/20">
          <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Вибрано {selected.size}
          </span>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-amber-600 underline underline-offset-2 hover:text-amber-800 dark:text-amber-400"
          >
            Скасувати
          </button>
          <div className="ml-auto">
            <button
              onClick={deleteSelected} disabled={deleting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? "Деактивую…" : "Деактивувати"}
            </button>
          </div>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                {/* Checkbox */}
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox" checked={allPageSelected}
                    onChange={toggleAll}
                    className="rounded border-neutral-300 dark:border-neutral-700"
                  />
                </th>
                <Th col="name"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Назва</Th>
                <Th col="sku"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Артикул</Th>
                <th className="px-4 py-3 font-medium">Категорія</th>
                <th className="px-4 py-3 font-medium">Од.</th>
                <Th col="stock"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Залишок</Th>
                <Th col="full_cost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Собів.</Th>
                <Th col="sale_price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Ціна</Th>
                <Th col="margin"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="text-right">Маржа</Th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-sm text-neutral-400">
                    {search || category !== "Всі" ? "Нічого не знайдено" : "Номенклатури ще немає"}
                  </td>
                </tr>
              ) : (
                paginated.map((p) => {
                  const avail  = stockByProduct.get(p.id) ?? 0;
                  const margin = calcMargin(p.sale_price, p.full_cost);
                  const isOut  = avail === 0 && stock.some((s) => s.product_id === p.id);
                  return (
                    <tr
                      key={p.id}
                      className={[
                        "transition-colors",
                        selected.has(p.id) ? "bg-cyan-50/50 dark:bg-cyan-950/10" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/40",
                      ].join(" ")}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox" checked={selected.has(p.id)}
                          onChange={() => toggleOne(p.id)}
                          className="rounded border-neutral-300 dark:border-neutral-700"
                        />
                      </td>

                      {/* Name */}
                      <td className="px-4 py-3">
                        <Link
                          href={`/warehouse/products/${p.id}`}
                          className="font-medium text-neutral-900 hover:text-cyan-600 dark:text-neutral-100 dark:hover:text-cyan-400"
                        >
                          {p.name}
                        </Link>
                      </td>

                      {/* SKU */}
                      <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        {p.sku}
                      </td>

                      {/* Categories */}
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {p.categories.map((c) => (
                            <span key={c}
                              className="cursor-pointer rounded-full bg-neutral-100 px-2 py-0.5 text-xs hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                              onClick={() => setCategory(c)}
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </td>

                      {/* Unit */}
                      <td className="px-4 py-3 text-xs text-neutral-500">{p.unit}</td>

                      {/* Stock */}
                      <td className="px-4 py-3 text-right">
                        <span className={[
                          "font-mono text-sm tabular-nums",
                          isOut ? "font-semibold text-red-600 dark:text-red-400"
                            : avail < 5 ? "text-amber-600 dark:text-amber-400"
                            : "text-neutral-700 dark:text-neutral-300",
                        ].join(" ")}>
                          {Math.round(avail)}
                        </span>
                      </td>

                      {/* Cost */}
                      <td className="px-4 py-3 text-right text-sm tabular-nums text-neutral-500">
                        {fmt(p.full_cost)}
                      </td>

                      {/* Price */}
                      <td className="px-4 py-3 text-right text-sm tabular-nums font-medium">
                        {fmt(p.sale_price)}
                      </td>

                      {/* Margin */}
                      <td className="px-4 py-3 text-right text-sm">
                        {margin !== null ? (
                          <span className={[
                            "font-medium tabular-nums",
                            margin >= 50 ? "text-emerald-600 dark:text-emerald-400"
                              : margin >= 20 ? "text-amber-600 dark:text-amber-400"
                              : "text-red-600 dark:text-red-400",
                          ].join(" ")}>
                            {margin.toFixed(0)}%
                          </span>
                        ) : "—"}
                      </td>

                      {/* Edit */}
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/warehouse/products/${p.id}`}
                          className="inline-flex size-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                          title="Відкрити"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination ─────────────────────────────────────────────────────── */}
        {sorted.length > 0 && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
            {/* Per-page */}
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <span>Рядків:</span>
              {PAGE_SIZES.map((s) => (
                <button
                  key={s}
                  onClick={() => setPageSize(s)}
                  className={[
                    "rounded px-2 py-0.5 text-sm transition-colors",
                    pageSize === s
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-800",
                  ].join(" ")}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Page info + navigation */}
            <div className="flex items-center gap-1">
              <span className="mr-2 text-sm text-neutral-400">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} з {sorted.length}
              </span>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
              >
                ‹
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                // Show: first, last, current ±1, and ellipsis
                const p = i + 1;
                if (totalPages <= 7) {
                  return (
                    <button key={p} onClick={() => setPage(p)}
                      className={["flex size-7 items-center justify-center rounded-md text-sm transition-colors",
                        page === p ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                          : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800",
                      ].join(" ")}>
                      {p}
                    </button>
                  );
                }
                return null;
              })}
              {totalPages > 7 && (
                <span className="px-1 text-sm text-neutral-400">
                  {page} / {totalPages}
                </span>
              )}
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => { setProducts((prev) => [p, ...prev]); }}
      />
    </div>
  );
}
