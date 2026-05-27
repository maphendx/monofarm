"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/Modal";

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";

type Product = { id: number; name: string; sku: string };
type Spec    = { id: number; name: string; version: number; is_default: boolean };

const COLUMNS: { status: BatchStatus; label: string; accent: string }[] = [
  { status: "draft",  label: "Заплановано", accent: "border-[var(--border-strong)] " },
  { status: "active", label: "Друкується",  accent: "border-[var(--accent)]" },
  { status: "done",   label: "Готово",      accent: "border-[var(--state-ok)]" },
];

import { CreateBatchModal, Batch } from "@/components/warehouse/CreateBatchModal";

// ── Batch card ────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, value)}%` }} />
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
          <span className="shrink-0 rounded-full bg-[rgba(56,189,248,.08)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">● live</span>
        )}
        {batch.status === "done" && (
          <span className="shrink-0 rounded-full bg-[rgba(34,197,94,.08)] px-2 py-0.5 text-xs font-medium text-[var(--state-ok)]">✓</span>
        )}
      </div>

      {batch.status !== "draft" ? (
        <>
          <ProgressBar value={pct} />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {batch.printed_qty}/{batch.target_qty} надруковано · {pct.toFixed(0)}%
            {defects > 0 && <span className="ml-1.5 text-[var(--state-error)]">{defects} брак</span>}
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
          className="mt-3 w-full rounded-md border border-[rgba(34,197,94,.3)] py-1.5 text-xs text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.08)] disabled:opacity-50 ">
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
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]  ">
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
