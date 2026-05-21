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

type Warehouse = { id: number; name: string; type: WarehouseType; location: string | null; is_active: boolean };

function AddModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (w: Warehouse) => void }) {
  const [name, setName]     = useState("");
  const [type, setType]     = useState<WarehouseType>("finished");
  const [loc, setLoc]       = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => { if (open) { setName(""); setType("finished"); setLoc(""); setError(null); } }, [open]);
  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const w = await api<Warehouse>("/api/warehouse/warehouses", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), type, location: loc.trim() || null }),
      });
      onAdd(w);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-4 font-semibold">Новий склад</h2>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Назва</span>
            <input required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Тип</span>
            <select value={type} onChange={(e) => setType(e.target.value as WarehouseType)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100">
              {(Object.keys(TYPE_META) as WarehouseType[]).map((t) => (
                <option key={t} value={t}>{TYPE_META[t].label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Місце</span>
            <input value={loc} onChange={(e) => setLoc(e.target.value)}
              placeholder="Полиця A, Офіс, …"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100" />
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
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

export default function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [addOpen,    setAddOpen]    = useState(false);

  const load = useCallback(async () => {
    try { setWarehouses(await api<Warehouse[]>("/api/warehouse/warehouses")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500">{warehouses.length} складів</p>
        <button onClick={() => setAddOpen(true)}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
          + Склад
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {warehouses.map((w) => {
          const meta = TYPE_META[w.type] ?? { label: w.type, cls: "bg-neutral-100 text-neutral-600" };
          return (
            <div key={w.id} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{w.name}</p>
                  {w.location && <p className="mt-0.5 text-xs text-neutral-400">{w.location}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                  {meta.label}
                </span>
              </div>
              {!w.is_active && (
                <p className="text-xs text-neutral-400 italic">Неактивний</p>
              )}
            </div>
          );
        })}
      </div>

      <AddModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(w) => setWarehouses((prev) => [...prev, w])}
      />
    </div>
  );
}
