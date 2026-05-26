"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";

type Batch = {
  id: number; product_name: string;
  target_qty: number; printed_qty: number; good_qty: number; defect_qty: number;
  status: BatchStatus; due_date: string | null; notes: string | null;
};

type Product = { id: number; name: string; sku: string };
type Spec    = { id: number; name: string; version: number; is_default: boolean };

const COLUMNS: { status: BatchStatus; label: string; accent: string }[] = [
  { status: "draft",  label: "Заплановано", accent: "border-[var(--border-strong)] " },
  { status: "active", label: "Друкується",  accent: "border-blue-400 dark:border-blue-600" },
  { status: "done",   label: "Готово",      accent: "border-emerald-400 dark:border-emerald-600" },
];

// ── Create batch modal ────────────────────────────────────────────────────────

function CreateBatchModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (b: Batch) => void }) {
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
    setProductId(""); setSpecId(""); setTargetQty("10"); setDueDate(""); setNotes(""); setError(null);
    api<Product[]>("/api/warehouse/products").then(setProducts).catch(() => {});
  }, [open]);

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

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-neutral-900   ";

  return (
    <Modal open={open} onClose={onClose} title="Нова виробнича партія"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  ">
          Скасувати
        </button>
        <button type="submit" form="batch-form" disabled={busy || !productId || parseInt(targetQty) < 1}
          className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50  ">
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

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ── Batch card ────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function BatchCard({ batch, onStatusChange }: {
  batch: Batch;
  onStatusChange: (id: number, s: BatchStatus) => Promise<void>;
}) {
  const pct     = batch.target_qty > 0 ? (batch.printed_qty / batch.target_qty) * 100 : 0;
  const defects = batch.printed_qty - batch.good_qty;
  const [busy, setBusy] = useState(false);

  async function move(newStatus: BatchStatus) {
    setBusy(true);
    try { await onStatusChange(batch.id, newStatus); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="font-medium leading-tight">{batch.product_name}</span>
        {batch.status === "active" && (
          <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">● live</span>
        )}
        {batch.status === "done" && (
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">✓</span>
        )}
      </div>

      {batch.status !== "draft" ? (
        <>
          <ProgressBar value={pct} />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {batch.printed_qty}/{batch.target_qty} надруковано · {pct.toFixed(0)}%
            {defects > 0 && <span className="ml-1.5 text-red-400">{defects} брак</span>}
          </p>
        </>
      ) : (
        <p className="text-xs text-[var(--text-faint)]">Ціль: {batch.target_qty} шт</p>
      )}

      {batch.notes && <p className="mt-1.5 text-xs text-[var(--text-faint)] italic truncate">{batch.notes}</p>}

      <div className="mt-2 flex gap-3 text-xs text-[var(--text-faint)]">
        {batch.due_date && <span>📅 {new Date(batch.due_date).toLocaleDateString("uk-UA")}</span>}
      </div>

      {batch.status === "draft" && (
        <button disabled={busy} onClick={() => move("active")}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50   ">
          → Запустити
        </button>
      )}
      {batch.status === "active" && (
        <button disabled={busy} onClick={() => move("done")}
          className="mt-3 w-full rounded-md border border-emerald-300 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/20">
          ✓ Завершити
        </button>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProductionPage() {
  const [batches,   setBatches]   = useState<Batch[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try { setBatches(await api<Batch[]>("/api/warehouse/batches")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changeStatus(id: number, newStatus: BatchStatus) {
    await api(`/api/warehouse/batches/${id}`, { method: "PATCH", body: JSON.stringify({ status: newStatus }) });
    setBatches((prev) => prev.map((b) => b.id === id ? { ...b, status: newStatus } : b));
  }

  if (loading) return <div className="text-sm text-[var(--text-muted)]">Завантаження…</div>;

  const byStatus = (s: BatchStatus) => batches.filter((b) => b.status === s);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setCreateOpen(true)}
          className="rounded-md bg-[var(--surface)] px-3 py-1.5 text-xs text-white hover:bg-neutral-700  ">
          + Партія
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <div key={col.status}>
              <div className={`mb-3 flex items-center gap-2 border-l-2 pl-2 ${col.accent}`}>
                <span className="text-sm font-medium">{col.label}</span>
                <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]  ">
                  {items.length}
                </span>
              </div>
              <div className="space-y-3">
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-faint)] ">
                    Порожньо
                  </div>
                ) : (
                  items.map((b) => <BatchCard key={b.id} batch={b} onStatusChange={changeStatus} />)
                )}
              </div>
            </div>
          );
        })}
      </div>

      <CreateBatchModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(b) => setBatches((prev) => [b, ...prev])}
      />
    </div>
  );
}
