"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";

export type Batch = {
  id: number; product_name: string;
  target_qty: number; printed_qty: number; good_qty: number; defect_qty: number;
  status: BatchStatus; due_date: string | null; notes: string | null;
};

type Product = { id: number; name: string; sku: string };
type Spec    = { id: number; name: string; version: number; is_default: boolean };

export function CreateBatchModal({
  open, onClose, onCreated, initialProductId
}: { 
  open: boolean; 
  onClose: () => void; 
  onCreated: (b: Batch) => void;
  initialProductId?: string;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [specs,    setSpecs]    = useState<Spec[]>([]);
  const [productId,  setProductId]  = useState("");
  const [specId,     setSpecId]     = useState("");
  const [targetQty,  setTargetQty]  = useState("10");
  const [dueDate,    setDueDate]    = useState("");
  const [notes,      setNotes]      = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setProductId(initialProductId || ""); 
    setSpecId(""); 
    setTargetQty("10"); 
    setDueDate(""); 
    setNotes(""); 
    setError(null);
    api<Product[]>("/api/warehouse/products").then(setProducts).catch(() => {});
  }, [open, initialProductId]);

  useEffect(() => {
    if (!productId) { setSpecs([]); setSpecId(""); return; }
    api<Spec[]>(`/api/warehouse/products/${productId}/specs`)
      .then((ss) => { setSpecs(ss); setSpecId(ss.find((s) => s.is_default)?.id.toString() ?? ss[0]?.id.toString() ?? ""); })
      .catch(() => {});
  }, [productId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        product_id: parseInt(productId),
        target_qty: parseInt(targetQty),
      };
      if (specId)   body.specification_id = parseInt(specId);
      if (dueDate)  body.due_date = dueDate;
      if (notes.trim()) body.notes = notes.trim();
      const b = await api<Batch>("/api/warehouse/batches", { method: "POST", body: JSON.stringify(body) });
      onCreated(b);
      onClose();
    } catch { setError("Помилка збереження"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)] ";

  return (
    <Modal open={open} onClose={onClose} title="Нова виробнича партія"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="batch-form" disabled={busy || !productId || parseInt(targetQty) < 1}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  ">
          {busy ? "Зберігаю…" : "Створити"}
        </button>
      </>}
    >
      <form id="batch-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Товар</span>
          <select required value={productId} onChange={(e) => setProductId(e.target.value)} className={inputCls}>
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

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Кількість (шт)</span>
            <input type="number" required min={1} value={targetQty} onChange={(e) => setTargetQty(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--text-muted)] ">Дедлайн</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)] ">Нотатка</span>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </label>

        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}
