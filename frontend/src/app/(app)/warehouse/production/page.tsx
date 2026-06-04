"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { Modal } from "@/components/ui/Modal";
import { CreateBatchModal, Batch, BatchComponent } from "@/components/warehouse/CreateBatchModal";
import { CloseBatchModal } from "@/components/warehouse/CloseBatchModal";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";

const COLUMNS: { status: BatchStatus; label: string; accent: string }[] = [
  { status: "draft",  label: "Заплановано", accent: "border-[var(--border-strong)] " },
  { status: "active", label: "Друкується",  accent: "border-[var(--accent)]" },
  { status: "done",   label: "Готово",      accent: "border-[var(--state-ok)]" },
];

// ── Batch card ────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hi)] ">
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function BomRow({ c }: { c: BatchComponent }) {
  const needed = parseFloat(c.total_qty);
  const avail  = c.available_stock != null ? parseFloat(c.available_stock) : null;
  const ok     = c.is_sufficient;
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="py-1.5 pr-2 text-xs">
        {c.product_name ?? c.name}
        {c.product_name && c.name !== c.product_name && (
          <span className="ml-1 text-[10px] text-[var(--text-faint)]">({c.name})</span>
        )}
      </td>
      <td className="py-1.5 pr-2 text-right text-xs tabular-nums text-[var(--text-muted)]">
        {needed} {c.unit}
      </td>
      <td className="py-1.5 text-right text-xs tabular-nums">
        {avail == null ? (
          <span className="text-[var(--text-faint)]">—</span>
        ) : (
          <span className={ok ? "text-[var(--state-ok)]" : "text-[var(--state-warn)]"}>
            {avail} {c.unit}
          </span>
        )}
      </td>
    </tr>
  );
}

function ProgressControls({ batch, onUpdate }: { batch: Batch; onUpdate: (b: Batch) => void }) {
  const [printed, setPrinted] = useState(batch.printed_qty);
  const [inputVal, setInputVal] = useState(String(batch.printed_qty));
  const inFlight = useRef(false);

  async function bump(delta: number) {
    const next = Math.min(Math.max(printed + delta, 0), batch.target_qty);
    if (next === printed) return;
    const prev = printed;
    setPrinted(next);
    setInputVal(String(next));
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const updated = await api<Batch>(`/api/warehouse/batches/${batch.id}/progress?printed_qty=${next}`, { method: "PATCH" });
      onUpdate(updated);
    } catch {
      setPrinted(prev);
      setInputVal(String(prev));
    } finally { inFlight.current = false; }
  }

  async function commitInput() {
    const val = Math.min(Math.max(parseInt(inputVal) || 0, 0), batch.target_qty);
    setInputVal(String(val));
    if (val === printed) return;
    const prev = printed;
    setPrinted(val);
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const updated = await api<Batch>(`/api/warehouse/batches/${batch.id}/progress?printed_qty=${val}`, { method: "PATCH" });
      onUpdate(updated);
    } catch {
      setPrinted(prev);
      setInputVal(String(prev));
    } finally { inFlight.current = false; }
  }

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <button onClick={() => bump(-1)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">−1</button>
      <input
        type="number" min={0} max={batch.target_qty}
        value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onBlur={commitInput}
        onKeyDown={e => e.key === "Enter" && commitInput()}
        className="w-14 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-center text-xs outline-none focus:border-[var(--accent)]"
      />
      <button onClick={() => bump(1)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">+1</button>
      <button onClick={() => bump(5)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">+5</button>
    </div>
  );
}

function BatchCard({ batch, archiveMode = false, onStatusChange, onOpenCloseModal, onDelete, onProgressUpdate }: {
  batch: Batch;
  archiveMode?: boolean;
  onStatusChange: (id: number, s: BatchStatus) => Promise<void>;
  onOpenCloseModal: (b: Batch) => void;
  onDelete: (id: number) => Promise<void>;
  onProgressUpdate: (b: Batch) => void;
}) {
  const { confirm, dialog } = useConfirm();
  const pct     = batch.target_qty > 0 ? (batch.printed_qty / batch.target_qty) * 100 : 0;
  const defects = batch.printed_qty - batch.good_qty;
  const [busy, setBusy]       = useState(false);
  const [bomOpen, setBomOpen] = useState(false);

  async function move(newStatus: BatchStatus) {
    setBusy(true);
    try { await onStatusChange(batch.id, newStatus); }
    finally { setBusy(false); }
  }

  async function handleDelete() {
    if (!await confirm({ message: "Видалити цю партію?", variant: "danger" })) return;
    setBusy(true);
    try { await onDelete(batch.id); }
    catch (err) {
      toast.error(err instanceof Error ? err.message : "Помилка видалення");
      setBusy(false);
    }
  }

  async function handleArchive() {
    if (!await confirm({ message: "Перемістити готову партію в архів?", variant: "danger" })) return;
    setBusy(true);
    try {
      await onStatusChange(batch.id, "cancelled");
      toast.success("Партію переміщено в архів");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Помилка архівації");
      setBusy(false);
    }
  }

  async function handleRestore() {
    setBusy(true);
    try {
      await onStatusChange(batch.id, "done");
      toast.success("Партію повернуто в готові");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Помилка відновлення");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4  ">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium leading-tight">{batch.product_name}</span>
          {batch.print_task_id && (
            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--accent)]">
              <span>🖨</span>
              <span className="truncate">#{batch.print_task_id}{batch.print_task_title ? ` · ${batch.print_task_title}` : ""}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {batch.status === "active" && (
            <span className="rounded-full bg-[rgba(56,189,248,.08)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">● live</span>
          )}
          {batch.status === "done" && (
            <span className="rounded-full bg-[rgba(34,197,94,.08)] px-2 py-0.5 text-xs font-medium text-[var(--state-ok)]">✓</span>
          )}
          {batch.status === "cancelled" && (
            <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">Архів</span>
          )}
          {batch.status === "done" && !archiveMode ? (
            <button disabled={busy} onClick={handleArchive} title="Архівувати партію" className="text-[var(--text-faint)] hover:text-[var(--text-muted)] disabled:opacity-50 transition-colors">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7H4m2 0v12a2 2 0 002 2h8a2 2 0 002-2V7M9 11h6M8 3h8l2 4H6l2-4z" /></svg>
            </button>
          ) : (
            <button disabled={busy} onClick={handleDelete} title="Видалити партію" className="text-[var(--text-faint)] hover:text-[var(--state-error)] disabled:opacity-50 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          )}
        </div>
      </div>

      {batch.status !== "draft" ? (
        <>
          <ProgressBar value={pct} />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {batch.printed_qty}/{batch.target_qty} надруковано · {pct.toFixed(0)}%
            {defects > 0 && <span className="ml-1.5 text-[var(--state-error)]">{defects} брак</span>}
          </p>
          {batch.status === "active" && (
            <ProgressControls batch={batch} onUpdate={onProgressUpdate} />
          )}
        </>
      ) : (
        <p className="text-xs text-[var(--text-faint)]">Ціль: {batch.target_qty} шт</p>
      )}

      {batch.notes && <p className="mt-1.5 text-xs text-[var(--text-faint)] italic truncate">{batch.notes}</p>}

      <div className="mt-2 flex gap-3 text-xs text-[var(--text-faint)]">
        {batch.due_date && <span>📅 {new Date(batch.due_date).toLocaleDateString("uk-UA")}</span>}
      </div>

      {batch.components.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setBomOpen(v => !v)}
            className="flex w-full items-center justify-between text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)]"
          >
            <span>
              Компоненти ({batch.components.filter(c => c.is_sufficient).length}/{batch.components.length} є на складі)
            </span>
            <span>{bomOpen ? "▲" : "▼"}</span>
          </button>
          {bomOpen && (
            <table className="mt-1.5 w-full">
              <thead>
                <tr>
                  <th className="pb-1 text-left text-[10px] font-medium text-[var(--text-faint)]">Компонент</th>
                  <th className="pb-1 text-right text-[10px] font-medium text-[var(--text-faint)]">Потрібно</th>
                  <th className="pb-1 text-right text-[10px] font-medium text-[var(--text-faint)]">Є</th>
                </tr>
              </thead>
              <tbody>
                {batch.components.map(c => <BomRow key={c.id} c={c} />)}
              </tbody>
            </table>
          )}
        </div>
      )}

      {batch.status === "draft" && (
        <button disabled={busy} onClick={() => move("active")}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50   ">
          → Запустити
        </button>
      )}
      {batch.status === "active" && (
        <button disabled={busy} onClick={() => onOpenCloseModal(batch)}
          className="mt-3 w-full rounded-md border border-[rgba(34,197,94,.3)] py-1.5 text-xs text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.08)] disabled:opacity-50 ">
          ✓ Завершити
        </button>
      )}
      {batch.status === "cancelled" && (
        <button disabled={busy} onClick={handleRestore}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
          Повернути в готові
        </button>
      )}
      {dialog}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProductionPage() {
  const [batches,   setBatches]   = useState<Batch[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchToClose, setBatchToClose] = useState<Batch | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const load = useCallback(async () => {
    try { setBatches(await api<Batch[]>("/api/warehouse/batches")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changeStatus(id: number, newStatus: BatchStatus) {
    await api(`/api/warehouse/batches/${id}`, { method: "PATCH", body: JSON.stringify({ status: newStatus }) });
    setBatches((prev) => prev.map((b) => b.id === id ? { ...b, status: newStatus } : b));
  }

  async function deleteBatch(id: number) {
    await api(`/api/warehouse/batches/${id}`, { method: "DELETE" });
    setBatches((prev) => prev.filter((b) => b.id !== id));
  }

  if (loading) return <PageSkeleton cols={6} />;

  const byStatus = (s: BatchStatus) => batches.filter((b) => b.status === s);
  const archived = byStatus("cancelled");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setArchiveOpen((v) => !v)}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
        >
          {archiveOpen ? "Поточні партії" : `Архів (${archived.length})`}
        </button>
        <button onClick={() => setCreateOpen(true)}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hi)]  ">
          + Партія
        </button>
      </div>

      {archiveOpen ? (
        <div>
          <div className="mb-3 flex items-center gap-2 border-l-2 border-[var(--border-strong)] pl-2">
            <span className="text-sm font-medium">Архів</span>
            <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {archived.length}
            </span>
          </div>
          {archived.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-faint)]">
              Архів порожній
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {archived.map((b) => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  archiveMode
                  onStatusChange={changeStatus}
                  onOpenCloseModal={setBatchToClose}
                  onDelete={deleteBatch}
                  onProgressUpdate={(updated) => setBatches(prev => prev.map(x => x.id === updated.id ? updated : x))}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
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
                  items.map((b) => <BatchCard key={b.id} batch={b} onStatusChange={changeStatus} onOpenCloseModal={setBatchToClose} onDelete={deleteBatch} onProgressUpdate={(updated) => setBatches(prev => prev.map(x => x.id === updated.id ? updated : x))} />)
                )}
              </div>
            </div>
          );
        })}
        </div>
      )}

      {createOpen && (
        <CreateBatchModal
          key="new"
          open
          onClose={() => setCreateOpen(false)}
          onCreated={(b) => setBatches((prev) => [b, ...prev])}
        />
      )}

      {batchToClose && (
        <CloseBatchModal
          key={batchToClose.id}
          batch={batchToClose}
          open
          onClose={() => setBatchToClose(null)}
          onClosed={(b) => setBatches((prev) => prev.map((x) => x.id === b.id ? b : x))}
        />
      )}
    </div>
  );
}
