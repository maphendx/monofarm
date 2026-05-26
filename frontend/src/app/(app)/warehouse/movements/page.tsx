"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

// ── Types ─────────────────────────────────────────────────────────────────────

type MovementType = "PRODUCTION_IN" | "PRODUCTION_OUT" | "SALE_OUT" | "PURCHASE_IN" | "DEFECT" | "ADJUSTMENT" | "TRANSFER";

const TYPE_META: Record<MovementType, { label: string; cls: string; needsFrom: boolean; needsTo: boolean }> = {
  PRODUCTION_IN:  { label: "Виробництво +", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", needsFrom: false, needsTo: true },
  PRODUCTION_OUT: { label: "Сировина −",    cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400",         needsFrom: true,  needsTo: false },
  SALE_OUT:       { label: "Продаж",        cls: "bg-cyan-500/15 text-[var(--accent)] ",          needsFrom: true,  needsTo: false },
  PURCHASE_IN:    { label: "Закупка",       cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400",    needsFrom: false, needsTo: true },
  DEFECT:         { label: "Брак",          cls: "bg-red-500/15 text-red-600 dark:text-red-400",             needsFrom: true,  needsTo: true },
  ADJUSTMENT:     { label: "Коригування",   cls: "bg-neutral-500/15 text-[var(--text-muted)] ", needsFrom: false, needsTo: true },
  TRANSFER:       { label: "Переміщення",   cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400",       needsFrom: true,  needsTo: true },
};

type Movement = {
  id: number; type: MovementType; product_name: string;
  quantity: string; unit: string; unit_cost: string | null; total_cost: string | null;
  warehouse_from_id: number | null; warehouse_to_id: number | null;
  reason: string | null; created_at: string;
};

type Product   = { id: number; name: string; sku: string };
type Warehouse = { id: number; name: string; type: string };

const TYPE_FILTERS = ["Всі", "Виробництво", "Продаж", "Закупка", "Брак", "Переміщення", "Коригування"] as const;
type TFilter = typeof TYPE_FILTERS[number];
const FILTER_MAP: Record<TFilter, MovementType[] | null> = {
  "Всі": null,
  "Виробництво": ["PRODUCTION_IN", "PRODUCTION_OUT"],
  "Продаж":      ["SALE_OUT"],
  "Закупка":     ["PURCHASE_IN"],
  "Брак":        ["DEFECT"],
  "Переміщення": ["TRANSFER"],
  "Коригування": ["ADJUSTMENT"],
};

// ── Create movement modal ─────────────────────────────────────────────────────

function CreateMovementModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (m: Movement) => void }) {
  const [products,    setProducts]   = useState<Product[]>([]);
  const [warehouses,  setWarehouses] = useState<Warehouse[]>([]);
  const [mType,       setMType]      = useState<MovementType>("PURCHASE_IN");
  const [productId,   setProductId]  = useState("");
  const [whFromId,    setWhFromId]   = useState("");
  const [whToId,      setWhToId]     = useState("");
  const [quantity,    setQuantity]   = useState("1");
  const [unit,        setUnit]       = useState("шт");
  const [unitCost,    setUnitCost]   = useState("");
  const [reason,      setReason]     = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMType("PURCHASE_IN"); setProductId(""); setWhFromId(""); setWhToId("");
    setQuantity("1"); setUnit("шт"); setUnitCost(""); setReason(""); setError(null);
    Promise.all([
      api<Product[]>("/api/warehouse/products"),
      api<Warehouse[]>("/api/warehouse/warehouses"),
    ]).then(([p, w]) => { setProducts(p); setWarehouses(w); }).catch(() => {});
  }, [open]);

  const meta = TYPE_META[mType];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        type:       mType,
        product_id: parseInt(productId),
        quantity:   parseFloat(quantity),
        unit,
      };
      if (meta.needsFrom && whFromId) body.warehouse_from_id = parseInt(whFromId);
      if (meta.needsTo   && whToId)   body.warehouse_to_id   = parseInt(whToId);
      if (unitCost) body.unit_cost = parseFloat(unitCost);
      if (reason.trim()) body.reason = reason.trim();

      const m = await api<Movement>("/api/warehouse/movements", { method: "POST", body: JSON.stringify(body) });
      onCreated(m);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "input";

  return (
    <Modal open={open} onClose={onClose} title="Новий рух товару"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="btn btn-ghost">
          Скасувати
        </button>
        <button type="submit" form="movement-form"
          disabled={busy || !productId || parseFloat(quantity) <= 0}
          className="btn btn-primary disabled:opacity-50">
          {busy ? "Зберігаю…" : "Зафіксувати"}
        </button>
      </>}
    >
      <form id="movement-form" onSubmit={submit} className="space-y-3 text-sm">

        {/* Type selector */}
        <div>
          <span className="mb-1.5 block text-[var(--text-muted)] ">Тип руху</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TYPE_META) as MovementType[]).map((t) => (
              <button key={t} type="button" onClick={() => setMType(t)}
                className={["rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  mType === t ? TYPE_META[t].cls + " ring-1 ring-current" : "bg-[var(--surface-hi)] text-[var(--text-muted)]  ",
                ].join(" ")}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Товар</span>
          <select required value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
            <option value="">— обери товар —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
        </label>

        {/* Warehouse selectors — conditional on type */}
        {(meta.needsFrom || meta.needsTo) && (
          <div className={`grid gap-3 ${meta.needsFrom && meta.needsTo ? "grid-cols-[1fr_auto_1fr]" : "grid-cols-1"}`}>
            {meta.needsFrom && (
              <label className="block">
                <span className="mb-1 block text-[var(--text-muted)] ">Звідки</span>
                <select value={whFromId} onChange={(e) => setWhFromId(e.target.value)} className={inputCls}>
                  <option value="">— склад —</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
            )}
            {meta.needsFrom && meta.needsTo && (
              <div className="flex items-end pb-2.5 text-[var(--text-faint)]">→</div>
            )}
            {meta.needsTo && (
              <label className="block">
                <span className="mb-1 block text-[var(--text-muted)] ">Куди</span>
                <select value={whToId} onChange={(e) => setWhToId(e.target.value)} className={inputCls}>
                  <option value="">— склад —</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <label className="block col-span-1">
            <span className="mb-1 block text-[var(--text-muted)] ">К-сть</span>
            <input type="number" required min={0.001} step="any" value={quantity}
              onChange={(e) => setQuantity(e.target.value)} className={inputCls} />
          </label>
          <label className="block col-span-1">
            <span className="mb-1 block text-[var(--text-muted)] ">Одиниця</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
              <option>шт</option><option>г</option><option>кг</option><option>м</option>
            </select>
          </label>
          <label className="block col-span-1">
            <span className="mb-1 block text-[var(--text-muted)] ">Ціна/од.</span>
            <input type="number" min={0} step="0.01" value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="₴ (опц.)"
              className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Причина / коментар</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </label>

        {unitCost && quantity && (
          <div className="rounded-md bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)] ">
            Сума: <span className="font-medium text-[var(--text)] ">
              ₴{(parseFloat(quantity) * parseFloat(unitCost)).toLocaleString("uk-UA", { maximumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MovementsPage() {
  const [movements,   setMovements]   = useState<Movement[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter,      setFilter]      = useState<TFilter>("Всі");
  const [createOpen,  setCreateOpen]  = useState(false);

  const load = useCallback(async () => {
    try { setMovements(await api<Movement[]>("/api/warehouse/movements?limit=200")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allowed  = FILTER_MAP[filter];
  const filtered = allowed ? movements.filter((m) => allowed.includes(m.type)) : movements;

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {TYPE_FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={["rounded-md px-2.5 py-1.5 text-xs transition-colors",
                filter === f
                  ? "bg-[var(--accent)] text-white  "
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]  ",
              ].join(" ")}>
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--surface-hi)]  ">↻</button>
          <button onClick={() => setCreateOpen(true)}
            className="btn btn-primary btn-sm">
            + Рух
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]  ">
            <tr>
              <th className="px-4 py-3 font-medium">Дата</th>
              <th className="px-4 py-3 font-medium">Тип</th>
              <th className="px-4 py-3 font-medium">Товар</th>
              <th className="px-4 py-3 font-medium text-right">К-сть</th>
              <th className="px-4 py-3 font-medium text-right">Сума</th>
              <th className="px-4 py-3 font-medium">Причина</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] dark:divide-neutral-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--text-faint)]">Немає записів</td></tr>
            ) : filtered.map((m) => {
              const meta = TYPE_META[m.type];
              const qty  = parseFloat(m.quantity);
              return (
                <tr key={m.id} className="hover:bg-[var(--surface-hi)] ">
                  <td className="px-4 py-3 font-mono text-xs text-[var(--text-faint)]">
                    {new Date(m.created_at).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 font-medium">{m.product_name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {qty > 0 ? "+" : ""}{qty.toFixed(0)} {m.unit}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--text-muted)]">
                    {m.total_cost ? `${parseFloat(m.total_cost).toFixed(2)} ₴` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-faint)]">{m.reason ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CreateMovementModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(m) => { setMovements((prev) => [m, ...prev]); }}
      />
    </div>
  );
}
