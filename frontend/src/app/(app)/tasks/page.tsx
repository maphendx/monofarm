"use client";

import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useUser } from "@/lib/auth-context";
import type { FarmTask, FarmTaskStatus, Filament, PrintTask, PrintTaskStatus } from "@/lib/types";
import { usePageTitle } from "@/lib/usePageTitle";

// ════════════════════════════════════════════════════════════════════════
// FARM TASKS (kanban)
// ════════════════════════════════════════════════════════════════════════

const COLUMNS: { id: FarmTaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "До виконання", color: "border-[var(--border-strong)] " },
  { id: "in_progress", label: "В процесі", color: "border-[var(--state-warn)]" },
  { id: "done", label: "Виконано", color: "border-[var(--state-ok)]" },
];

function isOverdue(deadline: string | null, status: FarmTaskStatus) {
  if (!deadline || status === "done") return false;
  return new Date(deadline) < new Date(new Date().toDateString());
}

function FarmTaskCard({
  task, onEdit, onDelete, dragging = false,
}: { task: FarmTask; onEdit: () => void; onDelete: () => void; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: `task-${task.id}`,
    data: { task },
  });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  const overdue = isOverdue(task.deadline, task.status);

  return (
    <div
      ref={setNodeRef} style={style} {...listeners} {...attributes}
      className={[
        "group relative cursor-grab rounded-lg border bg-[var(--bg-elevated)] p-3 shadow-sm active:cursor-grabbing ",
        dragging
          ? "opacity-50 ring-2 ring-neutral-400"
          : "border-[var(--border)] hover:border-[var(--border-strong)]  dark:hover:border-[var(--border-strong)]",
      ].join(" ")}
    >
      <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="rounded p-0.5 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">✎</button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="rounded p-0.5 text-xs text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)]">✕</button>
      </div>
      <p className="pr-10 text-sm font-medium leading-snug">{task.title}</p>
      {task.description && <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{task.description}</p>}
      {task.deadline && (
        <div className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
          overdue ? "bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
                  : "bg-[var(--surface-hi)] text-[var(--text-muted)]  "}`}>
          {overdue ? "⚠️" : "🗓"} {task.deadline}
        </div>
      )}
    </div>
  );
}

function KanbanColumn({
  col, tasks, onEdit, onDelete, onQuickAdd, draggingId,
}: {
  col: typeof COLUMNS[number]; tasks: FarmTask[];
  onEdit: (t: FarmTask) => void; onDelete: (t: FarmTask) => void;
  onQuickAdd: (status: FarmTaskStatus, title: string) => void; draggingId: number | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startAdding() { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0); }
  function commit() {
    if (draft.trim()) onQuickAdd(col.id, draft.trim());
    setDraft(""); setAdding(false);
  }

  return (
    <div className="flex min-w-56 flex-1 flex-col">
      <div className={`mb-3 flex items-center justify-between border-b-2 pb-2 ${col.color}`}>
        <span className="text-sm font-semibold">{col.label}</span>
        <span className="rounded-full bg-[var(--surface-hi)] px-2 py-0.5 text-xs text-[var(--text-muted)]  ">{tasks.length}</span>
      </div>
      <div ref={setNodeRef}
        className={["flex flex-1 flex-col gap-2 rounded-xl p-2 transition-colors",
          isOver ? "bg-[var(--surface-hi)] " : "bg-[var(--bg)] "].join(" ")}
        style={{ minHeight: 120 }}
      >
        {tasks.map((task) => (
          <FarmTaskCard key={task.id} task={task} onEdit={() => onEdit(task)}
            onDelete={() => onDelete(task)} dragging={draggingId === task.id} />
        ))}
        {adding ? (
          <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2  ">
            <input ref={inputRef} type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(""); setAdding(false); } }}
              placeholder="Назва завдання…" className="w-full bg-transparent text-sm outline-none" />
            <div className="mt-2 flex gap-2">
              <button onClick={commit} className="btn btn-primary btn-sm">Додати</button>
              <button onClick={() => { setDraft(""); setAdding(false); }} className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ">Скасувати</button>
            </div>
          </div>
        ) : (
          <button onClick={startAdding}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]  ">
            <span className="text-base leading-none">+</span> Додати картку
          </button>
        )}
      </div>
    </div>
  );
}

function FarmTaskEditModal({ task, onClose, onSaved }: { task: FarmTask | null; onClose: () => void; onSaved: (t: FarmTask) => void }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [status, setStatus] = useState<FarmTaskStatus>("todo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (task) { setTitle(task.title); setDesc(task.description ?? ""); setDeadline(task.deadline ?? ""); setStatus(task.status); setError(null); }
  }, [task]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!task) return; setBusy(true);
    try {
      const saved = await api<FarmTask>(`/api/tasks/farm/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), description: desc.trim() || null, deadline: deadline || null, status }),
      });
      onSaved(saved); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={!!task} onClose={() => { if (!busy) onClose(); }} title="Редагувати завдання"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost disabled:opacity-50">Скасувати</button>
        <button type="submit" form="edit-farm-form" disabled={busy || !title.trim()} className="btn btn-primary disabled:opacity-50">{busy ? "Зберігаю…" : "Зберегти"}</button>
      </>}
    >
      <form id="edit-farm-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block">Назва</span>
          <input type="text" required autoFocus value={title} onChange={e => setTitle(e.target.value)}
            className="input" /></label>
        <label className="block"><span className="mb-1 block">Опис</span>
          <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)}
            className="input" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1 block">Дедлайн</span>
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              className="input" /></label>
          <label className="block"><span className="mb-1 block">Статус</span>
            <select value={status} onChange={e => setStatus(e.target.value as FarmTaskStatus)}
              className="input">
              <option value="todo">До виконання</option>
              <option value="in_progress">В процесі</option>
              <option value="done">Виконано</option>
            </select></label>
        </div>
        {error && <p className="text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// COMPLETE MODAL (done flow: pieces + filament + cost)
// ════════════════════════════════════════════════════════════════════════

const DEFECT_PRESETS = ["Варпінг", "Відшарування шарів", "Забій сопла", "Збій живлення", "Помилка налаштувань", "Інше"];

function CompleteModal({ task, onClose, onDone }: {
  task: PrintTask | null;
  onClose: () => void;
  onDone: (updated: PrintTask) => void;
}) {
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [piecesOk, setPiecesOk] = useState(1);
  const [piecesDefective, setPiecesDefective] = useState(0);
  const [defectPreset, setDefectPreset] = useState("");
  const [defectOther, setDefectOther] = useState("");
  // per-slot: filament_id selection (index = slot index in filament_meta.used_g)
  const [slotFilament, setSlotFilament] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    setPiecesOk(task.quantity);
    setPiecesDefective(0);
    setDefectPreset("");
    setDefectOther("");
    setSlotFilament({});
    setError(null);
    api<Filament[]>("/api/filaments").then(setFilaments).catch(() => {});
  }, [task]);

  if (!task) return null;

  const meta = task.filament_meta;
  const usedG: number[] = meta?.used_g ?? [];
  const slotTypes: string[] = meta?.types ?? [];
  const slotColors: string[] = meta?.colors ?? [];
  const plannedQty = task.quantity || 1;
  const actualPrinted = piecesOk + piecesDefective;
  const scale = actualPrinted > 0 ? actualPrinted / plannedQty : 1;

  // build consumptions and preview cost
  const consumptions = usedG.map((g, i) => {
    const filId = slotFilament[i] ?? null;
    const actualG = Math.round(g * scale);
    const fil = filId != null ? filaments.find(f => f.id === filId) : null;
    const cost = fil?.cost_per_kg != null ? (actualG * fil.cost_per_kg) / 1000 : null;
    return { slot: i, filament_id: filId, grams: actualG, cost };
  });

  const totalCost = consumptions.reduce((s, c) => s + (c.cost ?? 0), 0);
  const costPerOk = piecesOk > 0 && totalCost > 0 ? totalCost / piecesOk : null;
  const hasCost = totalCost > 0;

  const defectReason = defectPreset === "Інше" ? defectOther.trim() || "Інше"
    : defectPreset || null;

  async function submit() {
    if (!task) return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        status: "done",
        pieces_ok: piecesOk,
        pieces_defective: piecesDefective,
      };
      if (defectReason) body.defect_reason = defectReason;
      const validConsumptions = consumptions.filter(c => c.filament_id != null && c.grams > 0);
      if (validConsumptions.length > 0) {
        body.filament_consumptions = validConsumptions.map(c => ({ filament_id: c.filament_id!, grams: c.grams }));
      }
      const updated = await api<PrintTask>(`/api/tasks/print/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onDone(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Помилка");
    } finally { setBusy(false); }
  }

  const inputCls = "input";

  return (
    <Modal open={!!task} onClose={() => { if (!busy) onClose(); }} title={`Завершити: ${task.title}`}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}
          className="btn btn-ghost disabled:opacity-50">
          Скасувати
        </button>
        <button onClick={submit} disabled={busy || piecesOk < 0}
          className="btn btn-primary disabled:opacity-50">
          {busy ? "Зберігаю…" : "Виконано ✓"}
        </button>
      </>}>
      <div className="space-y-4 text-sm">

        {/* result */}
        <div>
          <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Результат (планувалось {plannedQty} шт.)</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Добрих ✓</span>
              <input type="number" min={0} value={piecesOk} onChange={e => setPiecesOk(Math.max(0, Number(e.target.value)))} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Брак ✕</span>
              <input type="number" min={0} value={piecesDefective} onChange={e => setPiecesDefective(Math.max(0, Number(e.target.value)))} className={inputCls} />
            </label>
          </div>
        </div>

        {/* defect reason */}
        {piecesDefective > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Причина браку</p>
            <div className="flex flex-wrap gap-1.5">
              {DEFECT_PRESETS.map(p => (
                <button key={p} type="button" onClick={() => setDefectPreset(p)}
                  className={["rounded-full border px-2.5 py-1 text-xs transition", defectPreset === p
                    ? "border-[rgba(239,68,68,.4)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  "].join(" ")}>
                  {p}
                </button>
              ))}
            </div>
            {defectPreset === "Інше" && (
              <input type="text" value={defectOther} onChange={e => setDefectOther(e.target.value)}
                placeholder="Опишіть причину…" className={`mt-2 ${inputCls}`} autoFocus />
            )}
          </div>
        )}

        {/* filament slots */}
        {usedG.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">
              Котушки (фактично ~{actualPrinted} шт. × {Math.round(usedG.reduce((s,g)=>s+g,0) / plannedQty)}г)
            </p>
            <div className="space-y-2">
              {usedG.map((g, i) => {
                const actualG = Math.round(g * scale);
                const color = slotColors[i];
                const type = slotTypes[i];
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      {color && <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: color }} />}
                      <span className="truncate text-xs text-[var(--text-muted)] ">
                        Слот {i + 1}{type ? ` · ${type}` : ""} · {actualG}г
                      </span>
                    </div>
                    <select value={slotFilament[i] ?? ""}
                      onChange={e => setSlotFilament(prev => ({ ...prev, [i]: Number(e.target.value) }))}
                      className="w-40 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-xs outline-none  ">
                      <option value="">— не вказано —</option>
                      {filaments.map(f => (
                        <option key={f.id} value={f.id}>
                          {f.material} {f.color}{f.brand ? ` (${f.brand})` : ""}
                          {f.sku ? ` [${f.sku}]` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* cost preview */}
        {hasCost && (
          <div className="rounded-lg bg-[var(--bg)] px-4 py-3 ">
            <p className="text-xs text-[var(--text-muted)]">Собівартість матеріалів</p>
            <p className="mt-1 text-lg font-semibold">{totalCost.toFixed(2)} грн</p>
            {costPerOk != null && (
              <p className="text-xs text-[var(--text-muted)]">{costPerOk.toFixed(2)} грн/шт. (для {piecesOk} добрих)</p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PRINT TASKS (list + archive)
// ════════════════════════════════════════════════════════════════════════

const PRINT_STATUS_LABELS: Record<PrintTaskStatus, string> = {
  queued: "В черзі",
  in_progress: "В процесі",
  done: "Виконано",
  cancelled: "Скасовано",
};

const PRINT_STATUS_CLS: Record<PrintTaskStatus, string> = {
  queued: "badge badge-neutral",
  in_progress: "badge badge-warn",
  done: "badge badge-ok",
  cancelled: "badge badge-error",
};

function fmtMinutes(m: number | null) {
  if (!m) return "—";
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h > 0 ? `${h}г ${min}хв` : `${min}хв`;
}

function PrintTaskEditModal({ task, onClose, onSaved }: { task: PrintTask | null; onClose: () => void; onSaved: (t: PrintTask) => void }) {
  const [title, setTitle] = useState("");
  const [qty, setQty] = useState(1);
  const [status, setStatus] = useState<PrintTaskStatus>("queued");
  const [deadline, setDeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (task) {
      setTitle(task.title); setQty(task.quantity); setStatus(task.status);
      setDeadline(task.deadline ?? ""); setNotes(task.notes ?? ""); setError(null);
    }
  }, [task]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!task) return; setBusy(true);
    try {
      const saved = await api<PrintTask>(`/api/tasks/print/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), quantity: qty, status, deadline: deadline || null, notes: notes.trim() || null }),
      });
      onSaved(saved); onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={!!task} onClose={() => { if (!busy) onClose(); }} title="Редагувати завдання друку"
      footer={<>
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost disabled:opacity-50">Скасувати</button>
        <button type="submit" form="edit-print-form" disabled={busy || !title.trim()} className="btn btn-primary disabled:opacity-50">{busy ? "Зберігаю…" : "Зберегти"}</button>
      </>}
    >
      <form id="edit-print-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block">Назва</span>
          <input type="text" required autoFocus value={title} onChange={e => setTitle(e.target.value)}
            className="input" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1 block">Кількість</span>
            <input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))}
              className="input" /></label>
          <label className="block"><span className="mb-1 block">Статус</span>
            <select value={status} onChange={e => setStatus(e.target.value as PrintTaskStatus)}
              className="input">
              {(Object.keys(PRINT_STATUS_LABELS) as PrintTaskStatus[]).map(s => (
                <option key={s} value={s}>{PRINT_STATUS_LABELS[s]}</option>
              ))}
            </select></label>
        </div>
        <label className="block"><span className="mb-1 block">Дедлайн</span>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="input" /></label>
        <label className="block"><span className="mb-1 block">Примітки</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
            className="input" /></label>
        {error && <p className="text-[var(--state-error)]">{error}</p>}
      </form>
    </Modal>
  );
}

function PrintTasksTab() {
  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<PrintTaskStatus | "all">("all");
  const [editing, setEditing] = useState<PrintTask | null>(null);
  const [completing, setCompleting] = useState<PrintTask | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api<PrintTask[]>("/api/tasks/print");
      setTasks(all);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(task: PrintTask) {
    if (!confirm(`Видалити "${task.title}"?`)) return;
    await api(`/api/tasks/print/${task.id}`, { method: "DELETE" });
    setTasks(prev => prev.filter(t => t.id !== task.id));
  }

  function upsert(t: PrintTask) {
    setTasks(prev => { const i = prev.findIndex(x => x.id === t.id); if (i === -1) return prev; const c = [...prev]; c[i] = t; return c; });
  }

  const FILTER_OPTIONS: { value: PrintTaskStatus | "all"; label: string }[] = [
    { value: "all", label: "Усі" },
    { value: "queued", label: "В черзі" },
    { value: "in_progress", label: "В процесі" },
    { value: "done", label: "Виконано" },
    { value: "cancelled", label: "Скасовано" },
  ];

  const visible = filter === "all" ? tasks : tasks.filter(t => t.status === filter);

  const counts = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  if (loading) return <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>;

  return (
    <div className="space-y-4">
      {/* filter tabs */}
      <div className="flex flex-wrap gap-1">
        {FILTER_OPTIONS.map(opt => (
          <button key={opt.value} onClick={() => setFilter(opt.value)}
            className={["rounded-full px-3 py-1 text-sm transition",
              filter === opt.value
                ? "bg-[var(--accent)] text-white  "
                : "bg-[var(--surface-hi)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ",
            ].join(" ")}>
            {opt.label}
            {opt.value !== "all" && counts[opt.value] != null && (
              <span className="ml-1.5 opacity-60">{counts[opt.value]}</span>
            )}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-faint)]">Немає завдань</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] ">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg)]  ">
                <th className="px-4 py-2.5 text-left font-medium text-[var(--text-muted)]">Назва</th>
                <th className="px-3 py-2.5 text-center font-medium text-[var(--text-muted)]">Кіл.</th>
                <th className="px-3 py-2.5 text-left font-medium text-[var(--text-muted)]">Матеріал</th>
                <th className="px-3 py-2.5 text-left font-medium text-[var(--text-muted)]">Час</th>
                <th className="px-3 py-2.5 text-left font-medium text-[var(--text-muted)]">Дедлайн</th>
                <th className="px-3 py-2.5 text-left font-medium text-[var(--text-muted)]">Статус</th>
                <th className="px-3 py-2.5 text-left font-medium text-[var(--text-muted)]">Результат</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--bg-elevated)] ">
              {visible.map(task => {
                const costPerOk = task.material_cost_uah != null && task.pieces_ok
                  ? (task.material_cost_uah / task.pieces_ok).toFixed(2)
                  : null;
                return (
                  <tr key={task.id} className="hover:bg-[var(--surface-hi)] ">
                    <td className="px-4 py-2.5 font-medium">{task.title}</td>
                    <td className="px-3 py-2.5 text-center text-[var(--text-muted)]">×{task.quantity}</td>
                    <td className="px-3 py-2.5 text-[var(--text-muted)]">
                      {task.filament_type && <span>{task.filament_type}</span>}
                      {task.filament_color && <span className="text-[var(--text-faint)]"> · {task.filament_color}</span>}
                      {!task.filament_type && !task.filament_color && "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--text-muted)]">{fmtMinutes(task.estimated_minutes)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-muted)]">{task.deadline ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${PRINT_STATUS_CLS[task.status]}`}>
                        {PRINT_STATUS_LABELS[task.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {task.status === "done" && task.pieces_ok != null ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-[var(--state-ok)]">✓ {task.pieces_ok} шт.</span>
                            {(task.pieces_defective ?? 0) > 0 && (
                              <span className="text-[var(--state-error)]" title={task.defect_reason ?? ""}>
                                ✕ {task.pieces_defective}
                              </span>
                            )}
                          </div>
                          {task.material_cost_uah != null && (
                            <div className="text-[10px] text-[var(--text-faint)]">
                              {task.material_cost_uah.toFixed(2)} грн
                              {costPerOk && ` · ${costPerOk}/шт`}
                            </div>
                          )}
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 justify-end">
                        {(task.status === "queued" || task.status === "in_progress") && (
                          <button onClick={() => setCompleting(task)}
                            className="rounded px-2 py-1 text-xs font-medium text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.08)]"
                            title="Завершити">
                            ✓
                          </button>
                        )}
                        <button onClick={() => setEditing(task)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] ">✎</button>
                        <button onClick={() => remove(task)}
                          className="rounded p-1 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--state-error)]">✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PrintTaskEditModal task={editing} onClose={() => setEditing(null)} onSaved={t => { upsert(t); setEditing(null); }} />
      <CompleteModal task={completing} onClose={() => setCompleting(null)}
        onDone={t => { upsert(t); setCompleting(null); }} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PAGE
// ════════════════════════════════════════════════════════════════════════

export default function TasksPage() {
  usePageTitle("nav.tasks");
  const t = useT();
  useUser();
  const [tab, setTab] = useState<"farm" | "print">("farm");

  // farm kanban state
  const [farmTasks, setFarmTasks] = useState<FarmTask[]>([]);
  const [loadingFarm, setLoadingFarm] = useState(true);
  const [editing, setEditing] = useState<FarmTask | null>(null);
  const [draggingTask, setDraggingTask] = useState<FarmTask | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const loadFarm = useCallback(async () => {
    try {
      const [active, done] = await Promise.all([
        api<FarmTask[]>("/api/tasks/farm"),
        api<FarmTask[]>("/api/tasks/farm?status=done"),
      ]);
      const ids = new Set(active.map(t => t.id));
      setFarmTasks([...active, ...done.filter(t => !ids.has(t.id))]);
    } catch { /* ignore */ }
    finally { setLoadingFarm(false); }
  }, []);

  useEffect(() => { loadFarm(); }, [loadFarm]);

  function upsertFarm(t: FarmTask) {
    setFarmTasks(prev => { const i = prev.findIndex(x => x.id === t.id); if (i === -1) return [...prev, t]; const c = [...prev]; c[i] = t; return c; });
  }

  async function quickAdd(status: FarmTaskStatus, title: string) {
    const task = await api<FarmTask>("/api/tasks/farm", { method: "POST", body: JSON.stringify({ title, status }) });
    upsertFarm(task);
  }

  async function removeFarm(task: FarmTask) {
    await api(`/api/tasks/farm/${task.id}`, { method: "DELETE" });
    setFarmTasks(prev => prev.filter(t => t.id !== task.id));
  }

  function handleDragStart(event: DragStartEvent) {
    setDraggingTask((event.active.data.current?.task as FarmTask) ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingTask(null);
    const { active, over } = event;
    if (!over) return;
    const task = active.data.current?.task as FarmTask | undefined;
    const newStatus = over.id as FarmTaskStatus;
    if (!task || task.status === newStatus) return;
    const updated = await api<FarmTask>(`/api/tasks/farm/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: newStatus }) });
    upsertFarm(updated);
  }

  const byStatus = (s: FarmTaskStatus) => farmTasks.filter(t => t.status === s);

  return (
    <div className="flex flex-col gap-4">
      {/* tab switcher */}
      <div className="flex items-center gap-1 border-b border-[var(--border)] ">
        {([["farm", t("tasks.farmTasks")], ["print", t("tasks.printTasks")]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={["px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px",
              tab === id
                ? "border-[var(--border-strong)] text-[var(--text-hi)]  "
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)] ",
            ].join(" ")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "farm" && (
        loadingFarm ? <div className="text-sm text-[var(--text-muted)]">{t("common.loading")}</div> : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex gap-4 overflow-x-auto pb-4 items-start">
              {COLUMNS.map(col => {
                const colLabels: Record<string, string> = { todo: t("tasks.todo"), in_progress: t("tasks.inProgress"), done: t("tasks.done"), cancelled: t("tasks.cancelled") };
                return (
                <KanbanColumn key={col.id} col={{...col, label: colLabels[col.id] ?? col.label}} tasks={byStatus(col.id)}
                  onEdit={setEditing} onDelete={removeFarm}
                  onQuickAdd={quickAdd} draggingId={draggingTask?.id ?? null} />
                );
              })}
            </div>
            <DragOverlay dropAnimation={null}>
              {draggingTask && (
                <div className="w-72 cursor-grabbing rounded-lg border-2 border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3 shadow-xl ">
                  <p className="text-sm font-medium">{draggingTask.title}</p>
                  {draggingTask.description && <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{draggingTask.description}</p>}
                </div>
              )}
            </DragOverlay>
            <FarmTaskEditModal task={editing} onClose={() => setEditing(null)} onSaved={t => { upsertFarm(t); setEditing(null); }} />
          </DndContext>
        )
      )}

      {tab === "print" && <PrintTasksTab />}
    </div>
  );
}
