"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

type WarehouseType = "raw" | "wip" | "finished" | "defect";

const TYPE_META: Record<WarehouseType, { label: string; cls: string }> = {
  finished: { label: "Готова продукція", cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" },
  raw:      { label: "Сировина",         cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]" },
  wip:      { label: "В процесі",        cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]" },
  defect:   { label: "Брак",             cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]" },
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

// ── Warehouse modal (create + edit) ──────────────────────────────────────────

function WarehouseModal({
  warehouse, onClose, onSaved,
}: {
  warehouse: Warehouse | null;  // null = create mode
  onClose: () => void;
  onSaved: (w: Warehouse) => void;
}) {
  const isEdit = !!warehouse;
  const [name, setName]   = useState(warehouse?.name ?? "");
  const [type, setType]   = useState<WarehouseType>(warehouse?.type ?? "finished");
  const [loc,  setLoc]    = useState(warehouse?.location ?? "");
  const [active, setActive] = useState(warehouse?.is_active ?? true);
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { name: name.trim(), type, location: loc.trim() || null, ...(isEdit ? { is_active: active } : {}) };
      const w = isEdit
        ? await api<Warehouse>(`/api/warehouse/warehouses/${warehouse!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api<Warehouse>("/api/warehouse/warehouses", { method: "POST", body: JSON.stringify(body) });
      onSaved(w);
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
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-xl">
        <h2 className="mb-4 font-semibold">{isEdit ? "Редагувати склад" : "Новий склад"}</h2>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Назва</span>
            <input
              required autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none focus:border-[var(--border-focus)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Тип</span>
            <select
              value={type} onChange={(e) => setType(e.target.value as WarehouseType)}
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2"
            >
              {(Object.keys(TYPE_META) as WarehouseType[]).map((t) => (
                <option key={t} value={t}>{TYPE_META[t].label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)]">Місце</span>
            <input
              value={loc} onChange={(e) => setLoc(e.target.value)}
              placeholder="Полиця A, Офіс, …"
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 outline-none"
            />
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}
                className="accent-[var(--accent)]" />
              <span className="text-[var(--text-muted)]">Активний</span>
            </label>
          )}
          {err && <p className="text-sm text-[var(--state-error)]">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-md px-3 py-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
              Скасувати
            </button>
            <button type="submit" disabled={busy || !name.trim()}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:bg-[var(--accent-hi)] disabled:opacity-50">
              {busy ? "Зберігаю…" : isEdit ? "Зберегти" : "Додати"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WarehousesPage() {
  const router = useRouter();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stock,      setStock]      = useState<StockEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [modalWh,    setModalWh]    = useState<Warehouse | null | "create">(null);

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
    return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;
  }

  const active   = warehouses.filter((w) => w.is_active);
  const inactive = warehouses.filter((w) => !w.is_active);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Склади</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">{active.length} активних</p>
        </div>
        <button
          onClick={() => setModalWh("create")}
          className="rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hi)]"
        >
          + Склад
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {active.map((w) => {
          const meta  = TYPE_META[w.type] ?? { label: w.type, cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]" };
          const stats = buildStats(w.id, stock);
          return (
            <div key={w.id}
              className="group rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5 transition-colors hover:border-[var(--border-strong)]">
              {/* Header */}
              <div className="mb-4 flex items-start justify-between gap-2">
                <button
                  onClick={() => router.push(`/warehouse/warehouses/${w.id}`)}
                  className="min-w-0 text-left"
                >
                  <p className="truncate font-semibold hover:text-[var(--accent)]">{w.name}</p>
                  {w.location && (
                    <p className="mt-0.5 text-xs text-[var(--text-faint)]">{w.location}</p>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}>
                    {meta.label}
                  </span>
                  <button
                    onClick={() => router.push(`/warehouse/warehouses/${w.id}`)}
                    title="Комірки"
                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => setModalWh(w)}
                    title="Редагувати"
                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Видалити склад «${w.name}»?`)) return;
                      try {
                        await api(`/api/warehouse/warehouses/${w.id}`, { method: "DELETE" });
                        setWarehouses((prev) => prev.filter((x) => x.id !== w.id));
                      } catch (e: unknown) {
                        alert(e instanceof Error ? e.message : "Помилка видалення");
                      }
                    }}
                    title="Видалити"
                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,.08)] hover:text-[var(--state-error)]"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                      <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Divider */}
              <div className="mb-4 h-px bg-[var(--surface-hi)]" />

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold tabular-nums">{stats.sku_count}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-faint)]">SKU</p>
                </div>
                <div>
                  <p className="text-lg font-bold tabular-nums">{Math.round(stats.total_units)}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-faint)]">одиниць</p>
                </div>
                <div>
                  <p className={[
                    "text-lg font-bold tabular-nums",
                    stats.zero_stock > 0 ? "text-[var(--state-error)]" : "text-[var(--state-ok)]",
                  ].join(" ")}>
                    {stats.zero_stock}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-faint)]">нульових</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {inactive.length > 0 && (
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--text-faint)]">
            Неактивні
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {inactive.map((w) => {
              const meta = TYPE_META[w.type] ?? { label: w.type, cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]" };
              return (
                <div key={w.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 opacity-60  ">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-[var(--text-muted)]">{w.name}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${meta.cls}`}>{meta.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {warehouses.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-16 text-center ">
          <p className="text-sm text-[var(--text-muted)]">Складів ще немає</p>
          <button
            onClick={() => setModalWh("create")}
            className="mt-3 rounded-md bg-[var(--accent)] px-4 py-2 text-sm text-white hover:bg-[var(--accent-hi)]"
          >
            Додати перший склад
          </button>
        </div>
      )}

      {modalWh !== null && (
        <WarehouseModal
          warehouse={modalWh === "create" ? null : modalWh}
          onClose={() => setModalWh(null)}
          onSaved={(w) => {
            setWarehouses((prev) => {
              const idx = prev.findIndex((x) => x.id === w.id);
              return idx >= 0 ? prev.map((x) => x.id === w.id ? w : x) : [...prev, w];
            });
            setModalWh(null);
          }}
        />
      )}
    </div>
  );
}
