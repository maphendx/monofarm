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
import type { FarmTask, FarmTaskStatus } from "@/lib/types";

// ─── constants ────────────────────────────────────────────────────────────────

const COLUMNS: { id: FarmTaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "До виконання", color: "border-neutral-300 dark:border-neutral-700" },
  { id: "in_progress", label: "В процесі", color: "border-amber-400 dark:border-amber-600" },
  { id: "done", label: "Виконано", color: "border-emerald-400 dark:border-emerald-600" },
];

function isOverdue(deadline: string | null, status: FarmTaskStatus) {
  if (!deadline || status === "done") return false;
  return new Date(deadline) < new Date(new Date().toDateString());
}

// ─── Task card ────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onEdit,
  onDelete,
  dragging = false,
}: {
  task: FarmTask;
  onEdit: () => void;
  onDelete: () => void;
  dragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: `task-${task.id}`,
    data: { task },
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;
  const overdue = isOverdue(task.deadline, task.status);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={[
        "group relative cursor-grab rounded-lg border bg-white p-3 shadow-sm",
        "active:cursor-grabbing dark:bg-neutral-900",
        dragging
          ? "opacity-50 ring-2 ring-neutral-400"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600",
      ].join(" ")}
    >
      {/* action buttons — appear on hover */}
      <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="rounded p-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >✎</button>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="rounded p-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
        >✕</button>
      </div>

      <p className="pr-10 text-sm font-medium leading-snug">{task.title}</p>

      {task.description && (
        <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{task.description}</p>
      )}

      {task.deadline && (
        <div className={`mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
          overdue
            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
            : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
        }`}>
          {overdue ? "⚠️" : "🗓"} {task.deadline}
        </div>
      )}
    </div>
  );
}

// ─── Kanban column ────────────────────────────────────────────────────────────

function KanbanColumn({
  col,
  tasks,
  onEdit,
  onDelete,
  onQuickAdd,
  draggingId,
}: {
  col: typeof COLUMNS[number];
  tasks: FarmTask[];
  onEdit: (t: FarmTask) => void;
  onDelete: (t: FarmTask) => void;
  onQuickAdd: (status: FarmTaskStatus, title: string) => void;
  draggingId: number | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startAdding() {
    setAdding(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function commit() {
    if (draft.trim()) {
      onQuickAdd(col.id, draft.trim());
    }
    setDraft("");
    setAdding(false);
  }

  return (
    <div className="flex min-w-56 flex-1 flex-col">
      {/* column header */}
      <div className={`mb-3 flex items-center justify-between border-b-2 pb-2 ${col.color}`}>
        <span className="text-sm font-semibold">{col.label}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
          {tasks.length}
        </span>
      </div>

      {/* drop zone */}
      <div
        ref={setNodeRef}
        className={[
          "flex flex-1 flex-col gap-2 rounded-xl p-2 transition-colors",
          isOver ? "bg-neutral-100 dark:bg-neutral-800/60" : "bg-neutral-50 dark:bg-neutral-900/40",
        ].join(" ")}
        style={{ minHeight: 120 }}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onEdit={() => onEdit(task)}
            onDelete={() => onDelete(task)}
            dragging={draggingId === task.id}
          />
        ))}

        {/* inline quick-add */}
        {adding ? (
          <div className="rounded-lg border border-neutral-300 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") { setDraft(""); setAdding(false); }
              }}
              placeholder="Назва завдання…"
              className="w-full bg-transparent text-sm outline-none"
            />
            <div className="mt-2 flex gap-2">
              <button onClick={commit}
                className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900">
                Додати
              </button>
              <button onClick={() => { setDraft(""); setAdding(false); }}
                className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                Скасувати
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={startAdding}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <span className="text-base leading-none">+</span> Додати картку
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

function TaskEditModal({
  task,
  onClose,
  onSaved,
}: {
  task: FarmTask | null;
  onClose: () => void;
  onSaved: (t: FarmTask) => void;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [status, setStatus] = useState<FarmTaskStatus>("todo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDesc(task.description ?? "");
      setDeadline(task.deadline ?? "");
      setStatus(task.status);
      setError(null);
    }
  }, [task]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!task) return;
    setBusy(true);
    try {
      const saved = await api<FarmTask>(`/api/tasks/farm/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description: desc.trim() || null,
          deadline: deadline || null,
          status,
        }),
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!task}
      onClose={() => { if (!busy) onClose(); }}
      title="Редагувати завдання"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Скасувати
          </button>
          <button type="submit" form="edit-task-form" disabled={busy || !title.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
        </>
      }
    >
      <form id="edit-task-form" onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block">Назва</span>
          <input type="text" required autoFocus value={title} onChange={e => setTitle(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <label className="block">
          <span className="mb-1 block">Опис</span>
          <textarea rows={3} value={desc} onChange={e => setDesc(e.target.value)}
            className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block">Дедлайн</span>
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950" />
          </label>
          <label className="block">
            <span className="mb-1 block">Статус</span>
            <select value={status} onChange={e => setStatus(e.target.value as FarmTaskStatus)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none dark:border-neutral-700 dark:bg-neutral-950">
              <option value="todo">До виконання</option>
              <option value="in_progress">В процесі</option>
              <option value="done">Виконано</option>
            </select>
          </label>
        </div>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TasksPage() {
  useUser();

  const [tasks, setTasks] = useState<FarmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FarmTask | null>(null);
  const [draggingTask, setDraggingTask] = useState<FarmTask | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const load = useCallback(async () => {
    try {
      const [active, done] = await Promise.all([
        api<FarmTask[]>("/api/tasks/farm"),
        api<FarmTask[]>("/api/tasks/farm?status=done"),
      ]);
      const ids = new Set(active.map((t) => t.id));
      setTasks([...active, ...done.filter((t) => !ids.has(t.id))]);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function upsert(t: FarmTask) {
    setTasks((prev) => {
      const idx = prev.findIndex((x) => x.id === t.id);
      if (idx === -1) return [...prev, t];
      const copy = [...prev];
      copy[idx] = t;
      return copy;
    });
  }

  async function quickAdd(status: FarmTaskStatus, title: string) {
    const task = await api<FarmTask>("/api/tasks/farm", {
      method: "POST",
      body: JSON.stringify({ title, status }),
    });
    upsert(task);
  }

  async function remove(task: FarmTask) {
    await api(`/api/tasks/farm/${task.id}`, { method: "DELETE" });
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
  }

  function handleDragStart(event: DragStartEvent) {
    const task = event.active.data.current?.task as FarmTask | undefined;
    setDraggingTask(task ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingTask(null);
    const { active, over } = event;
    if (!over) return;
    const task = active.data.current?.task as FarmTask | undefined;
    const newStatus = over.id as FarmTaskStatus;
    if (!task || task.status === newStatus) return;

    const updated = await api<FarmTask>(`/api/tasks/farm/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: newStatus }),
    });
    upsert(updated);
  }

  const byStatus = (s: FarmTaskStatus) => tasks.filter((t) => t.status === s);

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Завдання</h1>
      </div>

      <div className="mt-4 flex gap-4 overflow-x-auto pb-4 items-start">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            col={col}
            tasks={byStatus(col.id)}
            onEdit={setEditing}
            onDelete={remove}
            onQuickAdd={quickAdd}
            draggingId={draggingTask?.id ?? null}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {draggingTask && (
          <div className="w-72 cursor-grabbing rounded-lg border-2 border-neutral-400 bg-white p-3 shadow-xl dark:bg-neutral-900">
            <p className="text-sm font-medium">{draggingTask.title}</p>
            {draggingTask.description && (
              <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{draggingTask.description}</p>
            )}
          </div>
        )}
      </DragOverlay>

      <TaskEditModal
        task={editing}
        onClose={() => setEditing(null)}
        onSaved={(t) => { upsert(t); setEditing(null); }}
      />
    </DndContext>
  );
}
