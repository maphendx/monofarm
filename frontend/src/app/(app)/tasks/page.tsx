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

import { Modal } from "@/components/Modal";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { FarmTask, FarmTaskStatus, PrintTask, PrintTaskStatus } from "@/lib/types";

// ════════════════════════════════════════════════════════════════════════
// FARM TASKS (kanban)
// ════════════════════════════════════════════════════════════════════════

const COLUMNS: { id: FarmTaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "До виконання", color: "border-neutral-300 dark:border-neutral-700" },
  { id: "in_progress", label: "В процесі", color: "border-amber-400 dark:border-amber-600" },
  { id: "done", label: "Виконано", color: "border-emerald-400 dark:border-emerald-600" },
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
        "group relative cursor-grab rounded-lg border bg-white p-3 shadow-sm active:cursor-grabbing dark:bg-neutral-900",
        dragging
          ? "opacity-50 ring-2 ring-neutral-400"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600",
      ].join(" ")}
    >
      <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="rounded p-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800">✎</button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="rounded p-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800">✕</button>
      </div>
      <p className="pr-10 text-sm font-medium leading-snug">{task.title}</p>
      {task.description && <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{task.description}</p>}
      {task.deadline && (
        <div className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
          overdue ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
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
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">{tasks.length}</span>
      </div>
      <div ref={setNodeRef}
        className={["flex flex-1 flex-col gap-2 rounded-xl p-2 transition-colors",
          isOver ? "bg-neutral-100 dark:bg-neutral-800/60" : "bg-neutral-50 dark:bg-neutral-900/40"].join(" ")}
        style={{ minHeight: 120 }}
      >
        {tasks.map((task) => (
          <FarmTaskCard key={task.id} task={task} onEdit={() => onEdit(task)}
            onDelete={() => onDelete(task)} dragging={draggingId === task.id} />
        ))}
        {adding ? (
          <div className="rounded-lg border border-neutral-300 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900">
            <input ref={inputRef} type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(""); setAdding(false); } }}
              placeholder="Назва завдання…" className="w-full bg-transparent text-sm outline-none" />
            <div className="mt-2 flex gap-2">
              <button onClick={commit} className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">Додати</button>
              <button onClick={() => { setDraft(""); setAdding(false); }} className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">Скасувати</button>
            </div>
          </div>
        ) : (
          <button onClick={startAdding}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300">
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
        <button type="button" onClick={onClose} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">Скасувати</button>
        <button type="submit" form="edit-farm-form" disabled={busy || !title.trim()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">{busy ? "Зберігаю…" : "Зберегти"}</button>
      </>}
    >
      <form id="edit-farm-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block">Назва</span>
          <input type="text" required autoFocus value={title} onChange={e => setTitle(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" /></label>
        <label className="block"><span className="mb-1 block">Опис</span>
          <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)}
            className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1 block">Дедлайн</span>
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950" /></label>
          <label className="block"><span className="mb-1 block">Статус</span>
            <select value={status} onChange={e => setStatus(e.target.value as FarmTaskStatus)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950">
              <option value="todo">До виконання</option>
              <option value="in_progress">В процесі</option>
              <option value="done">Виконано</option>
            </select></label>
        </div>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
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
  queued: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  cancelled: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
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
        <button type="button" onClick={onClose} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">Скасувати</button>
        <button type="submit" form="edit-print-form" disabled={busy || !title.trim()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">{busy ? "Зберігаю…" : "Зберегти"}</button>
      </>}
    >
      <form id="edit-print-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block"><span className="mb-1 block">Назва</span>
          <input type="text" required autoFocus value={title} onChange={e => setTitle(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="mb-1 block">Кількість</span>
            <input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950" /></label>
          <label className="block"><span className="mb-1 block">Статус</span>
            <select value={status} onChange={e => setStatus(e.target.value as PrintTaskStatus)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950">
              {(Object.keys(PRINT_STATUS_LABELS) as PrintTaskStatus[]).map(s => (
                <option key={s} value={s}>{PRINT_STATUS_LABELS[s]}</option>
              ))}
            </select></label>
        </div>
        <label className="block"><span className="mb-1 block">Дедлайн</span>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950" /></label>
        <label className="block"><span className="mb-1 block">Примітки</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950" /></label>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

function PrintTasksTab() {
  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<PrintTaskStatus | "all">("all");
  const [editing, setEditing] = useState<PrintTask | null>(null);

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

  if (loading) return <p className="text-sm text-neutral-500">Завантаження…</p>;

  return (
    <div className="space-y-4">
      {/* filter tabs */}
      <div className="flex flex-wrap gap-1">
        {FILTER_OPTIONS.map(opt => (
          <button key={opt.value} onClick={() => setFilter(opt.value)}
            className={["rounded-full px-3 py-1 text-sm transition",
              filter === opt.value
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700",
            ].join(" ")}>
            {opt.label}
            {opt.value !== "all" && counts[opt.value] != null && (
              <span className="ml-1.5 opacity-60">{counts[opt.value]}</span>
            )}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-400">Немає завдань</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-4 py-2.5 text-left font-medium text-neutral-500">Назва</th>
                <th className="px-3 py-2.5 text-center font-medium text-neutral-500">Кіл.</th>
                <th className="px-3 py-2.5 text-left font-medium text-neutral-500">Матеріал</th>
                <th className="px-3 py-2.5 text-left font-medium text-neutral-500">Час</th>
                <th className="px-3 py-2.5 text-left font-medium text-neutral-500">Дедлайн</th>
                <th className="px-3 py-2.5 text-left font-medium text-neutral-500">Статус</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-950">
              {visible.map(task => (
                <tr key={task.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2.5 font-medium">{task.title}</td>
                  <td className="px-3 py-2.5 text-center text-neutral-500">×{task.quantity}</td>
                  <td className="px-3 py-2.5 text-neutral-500">
                    {task.filament_type && (
                      <span>{task.filament_type}</span>
                    )}
                    {task.filament_color && (
                      <span className="text-neutral-400"> · {task.filament_color}</span>
                    )}
                    {!task.filament_type && !task.filament_color && "—"}
                  </td>
                  <td className="px-3 py-2.5 text-neutral-500">{fmtMinutes(task.estimated_minutes)}</td>
                  <td className="px-3 py-2.5 text-neutral-500">{task.deadline ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${PRINT_STATUS_CLS[task.status]}`}>
                      {PRINT_STATUS_LABELS[task.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setEditing(task)}
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800">✎</button>
                      <button onClick={() => remove(task)}
                        className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800">✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PrintTaskEditModal task={editing} onClose={() => setEditing(null)} onSaved={t => { upsert(t); setEditing(null); }} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PAGE
// ════════════════════════════════════════════════════════════════════════

export default function TasksPage() {
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
      <div className="flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {([["farm", "Завдання ферми"], ["print", "Завдання друку"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={["px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px",
              tab === id
                ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300",
            ].join(" ")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "farm" && (
        loadingFarm ? <div className="text-sm text-neutral-500">Завантаження…</div> : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex gap-4 overflow-x-auto pb-4 items-start">
              {COLUMNS.map(col => (
                <KanbanColumn key={col.id} col={col} tasks={byStatus(col.id)}
                  onEdit={setEditing} onDelete={removeFarm}
                  onQuickAdd={quickAdd} draggingId={draggingTask?.id ?? null} />
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {draggingTask && (
                <div className="w-72 cursor-grabbing rounded-lg border-2 border-neutral-400 bg-white p-3 shadow-xl dark:bg-neutral-900">
                  <p className="text-sm font-medium">{draggingTask.title}</p>
                  {draggingTask.description && <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{draggingTask.description}</p>}
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
