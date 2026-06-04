"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";
export type BatchPriority = "low" | "normal" | "high" | "urgent";

export type BatchComponent = {
  id: number; name: string;
  product_id: number | null; product_name: string | null;
  quantity: string; unit: string;
  total_qty: string;
  available_stock: string | null;
  is_sufficient: boolean;
};

export type Batch = {
  id: number; product_name: string; specification_id: number | null;
  target_qty: number; printed_qty: number; good_qty: number; defect_qty: number;
  status: BatchStatus; priority: BatchPriority; due_date: string | null; notes: string | null;
  print_task_id: number | null; print_task_title: string | null;
  created_at: string; updated_at: string;
  components: BatchComponent[];
};

type Product  = { id: number; name: string; sku: string; desired_stock: number | null };
type Spec     = { id: number; name: string; version: number; is_default: boolean };
type FarmTask = { id: number; title: string; quantity: number; status: string; product_id: number | null };
type StockRow = { available: string; desired_stock: number | null };

export function CreateBatchModal({
  open, onClose, onCreated, initialProductId, initialOrderId, orderNumber,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (b: Batch) => void;
  initialProductId?: string;
  initialOrderId?: number;
  orderNumber?: string;
}) {
  const [products,    setProducts]    = useState<Product[]>([]);
  const [specs,       setSpecs]       = useState<Spec[]>([]);
  const [farmTasks,   setFarmTasks]   = useState<FarmTask[]>([]);
  const [productId,   setProductId]   = useState(initialProductId || "");
  const [specId,      setSpecId]      = useState("");
  const [targetQty,   setTargetQty]   = useState("10");
  const [priority,    setPriority]    = useState<BatchPriority>("normal");
  const [dueDate,     setDueDate]     = useState("");
  const [notes,       setNotes]       = useState("");
  const [printTaskId, setPrintTaskId] = useState("");
  const [replenishHint, setReplenishHint] = useState<{ desired: number; available: number; qty: number } | null>(null);
  const orderId = initialOrderId;
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const targetTouched = useRef(false);
  const autoTargetForProduct = useRef<string | null>(null);
  const selectedProductId = useRef(productId);

  useEffect(() => {
    api<Product[]>("/api/warehouse/products").then(setProducts).catch(() => {});
    api<FarmTask[]>("/api/queue").then(setFarmTasks).catch(() => {});
    if (initialProductId) {
      api<Spec[]>(`/api/warehouse/products/${initialProductId}/specs`)
        .then((ss) => { setSpecs(ss); setSpecId(ss.find((s) => s.is_default)?.id.toString() ?? ss[0]?.id.toString() ?? ""); })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestTargetQty = useCallback(async (id: string) => {
    const product = products.find((p) => p.id === parseInt(id));
    try {
      const rows = await api<StockRow[]>(`/api/warehouse/stock?product_id=${id}`);
      if (selectedProductId.current !== id) return;
      const desired = rows.find((r) => r.desired_stock != null)?.desired_stock ?? product?.desired_stock ?? null;
      if (desired == null) {
        setReplenishHint(null);
        return;
      }

      const available = rows.reduce((sum, row) => {
        const value = parseFloat(row.available);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      const qty = Math.max(0, Math.ceil(desired - available));
      setReplenishHint({ desired, available, qty });

      if (!targetTouched.current || autoTargetForProduct.current === id) {
        setTargetQty(String(qty));
        autoTargetForProduct.current = id;
        targetTouched.current = false;
      }
    } catch {
      setReplenishHint(null);
    }
  }, [products]);

  useEffect(() => {
    selectedProductId.current = productId;
    if (!productId) {
      setReplenishHint(null);
      return;
    }
    void suggestTargetQty(productId);
  }, [productId, suggestTargetQty]);

  function handleProductChange(id: string) {
    setProductId(id);
    setSpecs([]);
    setSpecId("");
    targetTouched.current = false;
    autoTargetForProduct.current = null;
    if (!id) return;
    api<Spec[]>(`/api/warehouse/products/${id}/specs`)
      .then((ss) => { setSpecs(ss); setSpecId(ss.find((s) => s.is_default)?.id.toString() ?? ss[0]?.id.toString() ?? ""); })
      .catch(() => {});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsedTargetQty = parseInt(targetQty, 10);
    if (!Number.isFinite(parsedTargetQty) || parsedTargetQty < 1) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        product_id: parseInt(productId),
        target_qty: parsedTargetQty,
        priority,
      };
      if (specId)        body.specification_id = parseInt(specId);
      if (dueDate)       body.due_date = dueDate;
      if (notes.trim())  body.notes = notes.trim();
      if (printTaskId)   body.print_task_id = parseInt(printTaskId);
      if (orderId)       body.order_id = orderId;
      const b = await api<Batch>("/api/warehouse/batches", { method: "POST", body: JSON.stringify(body) });
      onCreated(b);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";
  const parsedTargetQty = parseInt(targetQty, 10);
  const canSubmit = Boolean(productId) && Number.isFinite(parsedTargetQty) && parsedTargetQty >= 1;

  return (
    <Modal open={open} onClose={onClose} title="Нова виробнича партія"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="batch-form" disabled={busy || !canSubmit}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
          {busy ? "Зберігаю…" : "Створити"}
        </button>
      </>}
    >
      <form id="batch-form" onSubmit={submit} className="space-y-3 text-sm">
        {orderNumber && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--state-warn)]/20 bg-[var(--state-warn)]/5 px-3 py-2 text-xs text-[var(--state-warn)]">
            <span>📦</span>
            <span>Замовлення <strong>{orderNumber}</strong> → при створенні партії статус зміниться на «Виробництво»</span>
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Товар</span>
          <select required value={productId} onChange={(e) => handleProductChange(e.target.value)} className={inputCls}>
            <option value="">— обери товар —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
        </label>

        {specs.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Специфікація</span>
            <select value={specId} onChange={(e) => setSpecId(e.target.value)} className={inputCls}>
              {specs.map((s) => <option key={s.id} value={s.id}>v{s.version} · {s.name}</option>)}
            </select>
          </label>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Кількість (шт)</span>
            <input
              type="number"
              required
              min={0}
              value={targetQty}
              onChange={(e) => { targetTouched.current = true; setTargetQty(e.target.value); }}
              className={inputCls}
            />
            {replenishHint && (
              <span className="mt-1 block text-xs text-[var(--text-faint)]">
                Бажаний {replenishHint.desired} · доступний {replenishHint.available.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} · потрібно {replenishHint.qty}
              </span>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Пріоритет</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as BatchPriority)} className={inputCls}>
              <option value="low">Низький</option>
              <option value="normal">Звичайний</option>
              <option value="high">Високий</option>
              <option value="urgent">Терміновий</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Дедлайн</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Коментар</span>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {(() => {
          const linked = farmTasks.filter(
            t => t.product_id === parseInt(productId) && t.status !== "done" && t.status !== "cancelled"
          );
          if (!productId || linked.length === 0) return null;
          return (
            <label className="block">
              <span className="mb-1 block text-[var(--text-muted)]">
                Задача на фермі <span className="text-[var(--text-faint)]">(опційно)</span>
              </span>
              <select value={printTaskId} onChange={e => setPrintTaskId(e.target.value)} className={inputCls}>
                <option value="">— не прив’язано —</option>
                {linked.map(t => (
                  <option key={t.id} value={t.id}>#{t.id} · {t.title} ×{t.quantity}</option>
                ))}
              </select>
            </label>
          );
        })()}

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
