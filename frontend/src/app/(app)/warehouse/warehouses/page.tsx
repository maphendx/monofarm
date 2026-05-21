"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type WarehouseType = "raw" | "wip" | "finished" | "defect";

const TYPE_META: Record<WarehouseType, { label: string; cls: string }> = {
  finished: { label: "Готова продукція", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  raw:      { label: "Сировина",         cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  wip:      { label: "В процесі",        cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  defect:   { label: "Брак",             cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
};

type Warehouse  = { id: number; name: string; type: WarehouseType; location: string | null; is_active: boolean };
type StockEntry = { product_id: number; warehouse_id: number; available: string; quantity: string };

type WarehouseStats = {
  sku_count:     number;
  total_units:   number;
  zero_stock:    number;
};

function buildStats(warehouseId: number, stock: StockEntry[]): WarehouseStats {
  const rows = stock.filter((s) => s.warehouse_id === warehouseId);
  const skus = new Set(rows.map((s) => s.product_id));
  const total = rows.reduce((acc, s) => acc + parseFloat(s.quantity), 0);
  const zeros = rows.filter((s) => parseFloat(s.available) <= 0).length;
  return { sku_count: skus.size, total_units: total, zero_stock: zeros };
}

// ── Add modal ─────────────────────────────────────────────────────────────────

function AddModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (w: Warehouse) => void }) {
  const [name, setName]   = useState("");
  const [type, setType]   = useState<WarehouseType>("finished");
  const [loc,  setLoc]    = useState("");
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(""); setType("finished"); setLoc(""); setErr(null); }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const w = await api<Warehouse>("/api/warehouse/warehouses", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), type, location: loc.trim() || null }),
      });
      onAdd(w);
      onClose();
    } catch {
      setErr("Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 font-semibold">Новий склад</h2>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Назва</span>
            <input
              required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Тип</span>
            <select
              value={type} onChange={(e) => setType(e.target.value as WarehouseType)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            >
              {(Object.keys(TYPE_META) as WarehouseType[]).map((t) => (
                <option key={t} value={t}>{TYPE_META[t].label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Місце</span>
            <input
              value={loc} onChange={(e) => setLoc(e.target.value)}
              placeholder="Полиця A, Офіс, …"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
          {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
              Скасувати
            </button>
            <button type="submit" disabled={busy || !name.trim()}
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

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stock,      setStock]      = useState<StockEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [addOpen,    setAddOpen]    = useState(false);

  const load = useCallback(async () => {
    try {
      const [whs, stk] = await Promise.all([
        api<Warehouse[]>("/api/warehouse/warehouses"),
        api<StockEntry[]>("/api/warehouse/stock"),
      ]);
      setWarehouses(whs);
      setStock(stk);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="text-sm text-neutral-500">Завантаження…</div>;
  }

  const active   = warehouses.filter((w) => w.is_active);
  const inactive = warehouses.filter((w) => !w.is_active);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Склади</h1>
          <p className="mt-0.5 text-sm text-neutral-500">{active.length} активних</p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="rounded-lg bg-neutral-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          + Склад
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {active.map((w) => {
          const meta  = TYPE_META[w.type] ?? { label: w.type, cls: "bg-neutral-100 text-neutral-600" };
          const stats = buildStats(w.id, stock);
          return (
            <div
              key={w.id}
              className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
            >
              {/* Header */}
              <div className="mb-4 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{w.name}</p>
                  {w.location && (
                    <p className="mt-0.5 text-xs text-neutral-400">{w.location}</p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}>
                  {meta.label}
                </span>
              </div>

              {/* Divider */}
              <div className="mb-4 h-px bg-neutral-100 dark:bg-neutral-800" />

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold tabular-nums">{stats.sku_count}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">SKU</p>
                </div>
                <div>
                  <p className="text-lg font-bold tabular-nums">{Math.round(stats.total_units)}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">одиниць</p>
                </div>
                <div>
                  <p className={[
                    "text-lg font-bold tabular-nums",
                    stats.zero_stock > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
                  ].join(" ")}>
                    {stats.zero_stock}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-400">нульових</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {inactive.length > 0 && (
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-400">
            Неактивні
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {inactive.map((w) => {
              const meta = TYPE_META[w.type] ?? { label: w.type, cls: "bg-neutral-100 text-neutral-600" };
              return (
                <div key={w.id}
                  className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 opacity-60 dark:border-neutral-800 dark:bg-neutral-900/50">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-neutral-500">{w.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${meta.cls}`}>{meta.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {warehouses.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-300 py-16 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500">Складів ще немає</p>
          <button
            onClick={() => setAddOpen(true)}
            className="mt-3 rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Додати перший склад
          </button>
        </div>
      )}

      <AddModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(w) => setWarehouses((prev) => [...prev, w])}
      />
    </div>
  );
}
