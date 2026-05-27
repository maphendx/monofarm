"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

export type MovementType = "PRODUCTION_IN" | "PRODUCTION_OUT" | "SALE_OUT" | "PURCHASE_IN" | "DEFECT" | "ADJUSTMENT" | "TRANSFER";

export const TYPE_META: Record<MovementType, { label: string; cls: string; needsFrom: boolean; needsTo: boolean }> = {
  PRODUCTION_IN:  { label: "Виробництво +", cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]", needsFrom: false, needsTo: true },
  PRODUCTION_OUT: { label: "Сировина −",    cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]",         needsFrom: true,  needsTo: false },
  SALE_OUT:       { label: "Продаж",        cls: "bg-[rgba(56,189,248,.08)] text-[var(--accent)]",          needsFrom: true,  needsTo: false },
  PURCHASE_IN:    { label: "Закупка",       cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400",    needsFrom: false, needsTo: true },
  DEFECT:         { label: "Брак",          cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",             needsFrom: true,  needsTo: true },
  ADJUSTMENT:     { label: "Коригування",   cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]", needsFrom: false, needsTo: true },
  TRANSFER:       { label: "Переміщення",   cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]",       needsFrom: true,  needsTo: true },
};

export type Movement = {
  id: number; type: MovementType; product_name: string;
  quantity: string; unit: string; unit_cost: string | null; total_cost: string | null;
  warehouse_from_id: number | null; warehouse_to_id: number | null;
  reason: string | null; created_at: string;
};

type Product   = { id: number; name: string; sku: string };
type Warehouse = { id: number; name: string; type: string };

export function CreateMovementModal({
  open, onClose, onCreated, initialType = "PURCHASE_IN"
}: { 
  open: boolean; 
  onClose: () => void; 
  onCreated: (m: Movement) => void;
  initialType?: MovementType;
}) {
  const [products,    setProducts]   = useState<Product[]>([]);
  const [warehouses,  setWarehouses] = useState<Warehouse[]>([]);
  const [mType,       setMType]      = useState<MovementType>(initialType);
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
    setMType(initialType); setProductId(""); setWhFromId(""); setWhToId("");
    setQuantity("1"); setUnit("шт"); setUnitCost(""); setReason(""); setError(null);
    Promise.all([
      api<Product[]>("/api/warehouse/products"),
      api<Warehouse[]>("/api/warehouse/warehouses"),
    ]).then(([p, w]) => { setProducts(p); setWarehouses(w); }).catch(() => {});
  }, [open, initialType]);

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
        <div>
          <span className="mb-1.5 block text-[var(--text-muted)]">Тип руху</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TYPE_META) as MovementType[]).map((t) => (
              <button key={t} type="button" onClick={() => setMType(t)}
                className={["rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  mType === t ? TYPE_META[t].cls + " ring-1 ring-current" : "bg-[var(--surface-hi)] text-[var(--text-muted)]",
                ].join(" ")}>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Товар</span>
          <select required value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
            <option value="">— обери товар —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
        </label>

        {(meta.needsFrom || meta.needsTo) && (
          <div className={`grid gap-3 ${meta.needsFrom && meta.needsTo ? "grid-cols-[1fr_auto_1fr]" : "grid-cols-1"}`}>
            {meta.needsFrom && (
              <label className="block">
                <span className="mb-1 block text-[var(--text-muted)]">Звідки</span>
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
                <span className="mb-1 block text-[var(--text-muted)]">Куди</span>
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
            <span className="mb-1 block text-[var(--text-muted)]">К-сть</span>
            <input type="number" required min={0.001} step="any" value={quantity}
              onChange={(e) => setQuantity(e.target.value)} className={inputCls} />
          </label>
          <label className="block col-span-1">
            <span className="mb-1 block text-[var(--text-muted)]">Одиниця</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
              <option>шт</option><option>г</option><option>кг</option><option>м</option>
            </select>
          </label>
          <label className="block col-span-1">
            <span className="mb-1 block text-[var(--text-muted)]">Ціна/од.</span>
            <input type="number" min={0} step="0.01" value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="₴ (опц.)"
              className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Причина / коментар</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </label>

        {unitCost && quantity && (
          <div className="rounded-md bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
            Сума: <span className="font-medium text-[var(--text)]">
              ₴{(parseFloat(quantity) * parseFloat(unitCost)).toLocaleString("uk-UA", { maximumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
