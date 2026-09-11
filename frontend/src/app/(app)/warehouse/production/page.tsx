"use client";

import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Archive, GripVertical, MessageSquare, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWarehouseStream } from "@/hooks/useWarehouseStream";
import { toast } from "sonner";
import { api, apiAll } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { Modal } from "@/components/ui/Modal";
import { CreateBatchModal, Batch, BatchComponent, BatchPriority } from "@/components/warehouse/CreateBatchModal";
import { CloseBatchModal } from "@/components/warehouse/CloseBatchModal";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = "draft" | "active" | "paused" | "done" | "cancelled";

const COLUMNS: { status: BatchStatus; label: string; accent: string }[] = [
  { status: "draft",  label: "Заплановано", accent: "border-[var(--border-strong)] " },
  { status: "active", label: "Друкується",  accent: "border-[var(--accent)]" },
  { status: "done",   label: "Готово",      accent: "border-[var(--state-ok)]" },
];

const DROP_ANIMATION = {
  duration: 180,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};

const PRIORITY_META: Record<BatchPriority, { label: string; className: string }> = {
  low: {
    label: "Низький",
    className: "border-[var(--border)] bg-[var(--surface-hi)] text-[var(--text-muted)]",
  },
  normal: {
    label: "Звичайний",
    className: "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)]",
  },
  high: {
    label: "Високий",
    className: "border-[rgba(245,158,11,.35)] bg-[rgba(245,158,11,.10)] text-[var(--state-warn)]",
  },
  urgent: {
    label: "Терміновий",
    className: "border-[rgba(239,68,68,.35)] bg-[rgba(239,68,68,.10)] text-[var(--state-error)]",
  },
};

const PRIORITY_WEIGHT: Record<BatchPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function remainingQty(batch: Batch) {
  return Math.max(0, batch.target_qty - batch.good_qty);
}

function sortBatches(items: Batch[]) {
  return [...items].sort((a, b) => {
    const byPriority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (byPriority !== 0) return byPriority;
    const byNeededQty = remainingQty(b) - remainingQty(a);
    if (byNeededQty !== 0) return byNeededQty;
    const aDue = a.due_date ? new Date(a.due_date).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.due_date ? new Date(b.due_date).getTime() : Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

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
    if (inFlight.current) return;
    const next = Math.min(Math.max(printed + delta, 0), batch.target_qty);
    if (next === printed) return;
    const prev = printed;
    setPrinted(next);
    setInputVal(String(next));
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
    if (inFlight.current) return;
    const val = Math.min(Math.max(parseInt(inputVal) || 0, 0), batch.target_qty);
    setInputVal(String(val));
    if (val === printed) return;
    const prev = printed;
    setPrinted(val);
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
      <button type="button" onClick={() => bump(-1)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">−1</button>
      <input
        type="number" min={0} max={batch.target_qty}
        value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onBlur={commitInput}
        onKeyDown={e => e.key === "Enter" && commitInput()}
        className="w-14 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-center text-xs outline-none focus:border-[var(--accent)]"
      />
      <button type="button" onClick={() => bump(1)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">+1</button>
      <button type="button" onClick={() => bump(5)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">+5</button>
    </div>
  );
}

function BatchCard({
  batch,
  archiveMode = false,
  dragging = false,
  onStatusChange,
  onOpenCloseModal,
  onDelete,
  onProgressUpdate,
  onPatch,
  onEditMeta,
}: {
  batch: Batch;
  archiveMode?: boolean;
  dragging?: boolean;
  onStatusChange: (id: number, s: BatchStatus) => Promise<void>;
  onOpenCloseModal: (b: Batch) => void;
  onDelete: (id: number) => Promise<void>;
  onProgressUpdate: (b: Batch) => void;
  onPatch: (id: number, payload: Partial<Pick<Batch, "priority" | "notes" | "due_date" | "target_qty" | "status">>) => Promise<Batch>;
  onEditMeta: (b: Batch) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `batch-${batch.id}`,
    data: { batch },
    disabled: archiveMode,
  });
  const { confirm, dialog } = useConfirm();
  const pct     = batch.target_qty > 0 ? (batch.printed_qty / batch.target_qty) * 100 : 0;
  const defects = batch.defect_qty;
  const [busy, setBusy]       = useState(false);
  const [bomOpen, setBomOpen] = useState(false);
  const priority = PRIORITY_META[batch.priority];

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

  async function handlePriorityChange(value: BatchPriority) {
    setBusy(true);
    try {
      await onPatch(batch.id, { priority: value });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Помилка зміни пріоритету");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={[
        "rounded-xl border bg-[var(--bg-elevated)] p-4 shadow-sm transition-[border-color,box-shadow,opacity] duration-150",
        dragging || isDragging
          ? "border-[var(--border-strong)] opacity-45"
          : "border-[var(--border)] hover:border-[var(--border-strong)]",
      ].join(" ")}
    >
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
          {!archiveMode && (
            <button
              ref={setActivatorNodeRef}
              type="button"
              title="Перетягнути"
              className="touch-none select-none cursor-grab rounded p-0.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)] active:cursor-grabbing"
              {...listeners}
              {...attributes}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
          {batch.status === "active" && (
            <span className="rounded-full bg-[rgba(56,189,248,.08)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">● live</span>
          )}
          {batch.status === "done" && (
            <span className="rounded-full bg-[rgba(34,197,94,.08)] px-2 py-0.5 text-xs font-medium text-[var(--state-ok)]">✓</span>
          )}
          {batch.status === "cancelled" && (
            <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">Архів</span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onEditMeta(batch)}
            title="Коментар і пріоритет"
            className="rounded p-0.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)] disabled:opacity-50"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          {batch.status === "done" && !archiveMode ? (
            <button type="button" disabled={busy} onClick={handleArchive} title="Архівувати партію" className="rounded p-0.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--text-muted)] disabled:opacity-50">
              <Archive className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={handleDelete} title="Видалити партію" className="rounded p-0.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)] disabled:opacity-50">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={batch.priority}
          disabled={busy}
          onChange={(e) => handlePriorityChange(e.target.value as BatchPriority)}
          className={`max-w-full rounded-full border px-2 py-0.5 text-xs outline-none transition focus:border-[var(--border-focus)] disabled:opacity-50 ${priority.className}`}
        >
          {Object.entries(PRIORITY_META).map(([value, meta]) => (
            <option key={value} value={value}>{meta.label}</option>
          ))}
        </select>
        {batch.due_date && (
          <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-[var(--text-muted)]">
            {new Date(batch.due_date).toLocaleDateString("uk-UA")}
          </span>
        )}
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

      {batch.notes && <p className="mt-1.5 line-clamp-2 text-xs text-[var(--text-faint)] italic">{batch.notes}</p>}

      {batch.components.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
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
        <button type="button" disabled={busy} onClick={() => move("active")}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50   ">
          → Запустити
        </button>
      )}
      {batch.status === "active" && (
        <button type="button" disabled={busy} onClick={() => onOpenCloseModal(batch)}
          className="mt-3 w-full rounded-md border border-[rgba(34,197,94,.3)] py-1.5 text-xs text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.08)] disabled:opacity-50 ">
          ✓ Завершити
        </button>
      )}
      {batch.status === "cancelled" && (
        <button type="button" disabled={busy} onClick={handleRestore}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50">
          Повернути в готові
        </button>
      )}
      {dialog}
    </div>
  );
}

function BatchMetaModal({
  batch,
  onClose,
  onSaved,
}: {
  batch: Batch | null;
  onClose: () => void;
  onSaved: (id: number, payload: Partial<Pick<Batch, "priority" | "notes">>) => Promise<Batch>;
}) {
  const [priority, setPriority] = useState<BatchPriority>("normal");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!batch) return;
    setPriority(batch.priority);
    setNotes(batch.notes ?? "");
    setError(null);
  }, [batch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!batch || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSaved(batch.id, {
        priority,
        notes: notes.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  if (!batch) return null;

  const inputCls = "w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)]";

  return (
    <Modal
      open
      onClose={onClose}
      title="Пріоритет і коментар"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50"
          >
            Скасувати
          </button>
          <button
            type="submit"
            form="batch-meta-form"
            disabled={busy}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-hi)] disabled:opacity-50"
          >
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>
      }
    >
      <form id="batch-meta-form" onSubmit={submit} className="space-y-3 text-sm">
        <p className="font-medium">{batch.product_name}</p>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Пріоритет</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as BatchPriority)} className={inputCls}>
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <option key={value} value={value}>{meta.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--text-muted)]">Коментар</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className={`${inputCls} resize-none`}
            placeholder="Деталі для оператора, пакування, нюанси друку..."
          />
        </label>
        {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

function BatchColumn({
  col,
  items,
  draggingId,
  onStatusChange,
  onOpenCloseModal,
  onDelete,
  onProgressUpdate,
  onPatch,
  onEditMeta,
}: {
  col: typeof COLUMNS[number];
  items: Batch[];
  draggingId: number | null;
  onStatusChange: (id: number, s: BatchStatus) => Promise<void>;
  onOpenCloseModal: (b: Batch) => void;
  onDelete: (id: number) => Promise<void>;
  onProgressUpdate: (b: Batch) => void;
  onPatch: (id: number, payload: Partial<Pick<Batch, "priority" | "notes" | "due_date" | "target_qty" | "status">>) => Promise<Batch>;
  onEditMeta: (b: Batch) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.status });

  return (
    <div className="flex min-w-0 flex-col">
      <div className={`mb-3 flex items-center gap-2 border-l-2 pl-2 ${col.accent}`}>
        <span className="text-sm font-medium">{col.label}</span>
        <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {items.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={[
          "min-h-32 space-y-3 rounded-xl p-2 transition-[background-color,box-shadow] duration-150",
          isOver ? "bg-[var(--surface-hi)] shadow-inner ring-1 ring-[var(--border-strong)]" : "bg-[var(--bg)]",
        ].join(" ")}
      >
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--text-faint)]">
            Порожньо
          </div>
        ) : (
          items.map((b) => (
            <BatchCard
              key={b.id}
              batch={b}
              dragging={draggingId === b.id}
              onStatusChange={onStatusChange}
              onOpenCloseModal={onOpenCloseModal}
              onDelete={onDelete}
              onProgressUpdate={onProgressUpdate}
              onPatch={onPatch}
              onEditMeta={onEditMeta}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProductionPage() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [batches,   setBatches]   = useState<Batch[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchToClose, setBatchToClose] = useState<Batch | null>(null);
  const [batchToEdit, setBatchToEdit] = useState<Batch | null>(null);
  const [draggingBatch, setDraggingBatch] = useState<Batch | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const { version } = useWarehouseStream();

  const load = useCallback(async () => {
    try { setBatches(await apiAll<Batch>("/api/warehouse/batches")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load, version]);

  async function patchBatch(
    id: number,
    payload: Partial<Pick<Batch, "priority" | "notes" | "due_date" | "target_qty" | "status">>,
  ) {
    const updated = await api<Batch>(`/api/warehouse/batches/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    setBatches((prev) => prev.map((b) => b.id === id ? updated : b));
    return updated;
  }

  async function changeStatus(id: number, newStatus: BatchStatus) {
    await patchBatch(id, { status: newStatus });
  }

  async function deleteBatch(id: number) {
    await api(`/api/warehouse/batches/${id}`, { method: "DELETE" });
    setBatches((prev) => prev.filter((b) => b.id !== id));
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingBatch((event.active.data.current?.batch as Batch | undefined) ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingBatch(null);
    const { active, over } = event;
    if (!over) return;
    const batch = active.data.current?.batch as Batch | undefined;
    const newStatus = over.id as BatchStatus;
    if (!batch || batch.status === newStatus) return;

    if (batch.status === "done" && newStatus !== "done") {
      toast.error("Готову партію не відкриваємо перетягуванням, бо вона вже могла створити складські рухи");
      return;
    }

    if (newStatus === "done") {
      setBatchToClose(batch);
      return;
    }

    try {
      await changeStatus(batch.id, newStatus);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Помилка переміщення партії");
    }
  }

  if (loading) return <PageSkeleton cols={6} />;

  const byStatus = (s: BatchStatus) => sortBatches(batches.filter((b) => b.status === s));
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
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              {archived.map((b) => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  archiveMode
                  onStatusChange={changeStatus}
                  onOpenCloseModal={setBatchToClose}
                  onDelete={deleteBatch}
                  onProgressUpdate={(updated) => setBatches(prev => prev.map(x => x.id === updated.id ? updated : x))}
                  onPatch={patchBatch}
                  onEditMeta={setBatchToEdit}
                />
              ))}
            </div>
          )}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>}
          title="Партій ще немає"
          description="Запустіть першу партію виробництва — або відправте товар у виробництво зі сторінки замовлень."
          action={{ label: "+ Партія", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {COLUMNS.map((col) => (
              <BatchColumn
                key={col.status}
                col={col}
                items={byStatus(col.status)}
                draggingId={draggingBatch?.id ?? null}
                onStatusChange={changeStatus}
                onOpenCloseModal={setBatchToClose}
                onDelete={deleteBatch}
                onProgressUpdate={(updated) => setBatches(prev => prev.map(x => x.id === updated.id ? updated : x))}
                onPatch={patchBatch}
                onEditMeta={setBatchToEdit}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={DROP_ANIMATION}>
            {draggingBatch && (
              <div className="w-72 cursor-grabbing rounded-xl border-2 border-[var(--border-strong)] bg-[var(--bg-elevated)] p-4 shadow-xl">
                <p className="text-sm font-medium">{draggingBatch.product_name}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {draggingBatch.printed_qty}/{draggingBatch.target_qty} надруковано
                </p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
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

      {batchToEdit && (
        <BatchMetaModal
          batch={batchToEdit}
          onClose={() => setBatchToEdit(null)}
          onSaved={patchBatch}
        />
      )}
    </div>
  );
}
