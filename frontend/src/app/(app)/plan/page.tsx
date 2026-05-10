"use client";

import {
  DndContext,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CreateTaskModal } from "@/components/plan/CreateTaskModal";
import { PrinterDropZone } from "@/components/plan/PrinterDropZone";
import { TaskQueueItem } from "@/components/plan/TaskQueueItem";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { PlanEntry, PrintTask, Printer } from "@/lib/types";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function PlanPage() {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";

  const [planDate, setPlanDate] = useState(todayStr);
  const [tasks, setTasks] = useState<PrintTask[]>([]);
  const [entries, setEntries] = useState<PlanEntry[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [draggingTask, setDraggingTask] = useState<PrintTask | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, e, p] = await Promise.all([
        api<PrintTask[]>("/api/tasks/print?status=queued"),
        api<PlanEntry[]>(`/api/plan?plan_date=${planDate}`),
        api<Printer[]>("/api/printers"),
      ]);
      setTasks(t);
      setEntries(e);
      setPrinters(p);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [planDate]);

  useEffect(() => {
    load();
  }, [load]);

  // How many plan entries each task has today (for the badge)
  const assignedCountByTask = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of entries) {
      counts.set(e.task_id, (counts.get(e.task_id) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const entriesByPrinter = useMemo(() => {
    const map = new Map<number, PlanEntry[]>();
    for (const e of entries) {
      const arr = map.get(e.printer_id) ?? [];
      arr.push(e);
      map.set(e.printer_id, arr);
    }
    return map;
  }, [entries]);

  function handleDragStart(event: DragStartEvent) {
    const task = event.active.data.current?.task as PrintTask | undefined;
    setDraggingTask(task ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = Number(String(active.id).replace("task-", ""));
    const printerId = over.data.current?.printerId as number | undefined;
    if (!printerId) return;

    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    // Prevent duplicate assignment to same printer on same day
    const alreadyAssigned = entries.some(
      (e) => e.task_id === taskId && e.printer_id === printerId,
    );
    if (alreadyAssigned) return;

    try {
      const entry = await api<PlanEntry>("/api/plan", {
        method: "POST",
        body: JSON.stringify({
          plan_date: planDate,
          printer_id: printerId,
          task_id: taskId,
        }),
      });
      setEntries((prev) => [...prev, entry]);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  function deleteTask(taskId: number) {
    api(`/api/tasks/print/${taskId}`, { method: "DELETE" }).then(() => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      setEntries((prev) => prev.filter((e) => e.task_id !== taskId));
    });
  }

  const doneCount = entries.filter((e) => e.done).length;

  if (loading) {
    return <div className="text-sm text-neutral-500">Завантаження…</div>;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4" style={{ height: "calc(100vh - 5rem)" }}>
        {/* ── Left: task queue ── */}
        <div className="flex w-72 shrink-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Черга задач</h2>
            {canEdit && (
              <button
                onClick={() => setCreateTaskOpen(true)}
                className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
              >
                + Задача
              </button>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {tasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-300 px-3 py-8 text-center text-xs text-neutral-400 dark:border-neutral-700">
                Черга порожня — натисни + Задача
              </div>
            ) : (
              tasks.map((task) => (
                <TaskQueueItem
                  key={task.id}
                  task={task}
                  assignedCount={assignedCountByTask.get(task.id) ?? 0}
                  onDelete={deleteTask}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />

        {/* ── Right: plan board ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">План на день</h2>
              <input
                type="date"
                value={planDate}
                onChange={(e) => setPlanDate(e.target.value)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </div>
            {entries.length > 0 && (
              <span className="text-sm text-neutral-500">
                ✓ {doneCount}/{entries.length}
              </span>
            )}
          </div>

          <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {printers.map((printer) => (
              <PrinterDropZone
                key={printer.id}
                printer={printer}
                entries={entriesByPrinter.get(printer.id) ?? []}
                planDate={planDate}
                onEntryAdded={(e) => setEntries((prev) => [...prev, e])}
                onEntryUpdated={(e) =>
                  setEntries((prev) => prev.map((x) => (x.id === e.id ? e : x)))
                }
                onEntryRemoved={(id) =>
                  setEntries((prev) => prev.filter((x) => x.id !== id))
                }
              />
            ))}
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {draggingTask && (
          <div className="w-64 cursor-grabbing rounded-lg border-2 border-neutral-400 bg-white p-3 shadow-xl dark:bg-neutral-900">
            <div className="text-sm font-medium">{draggingTask.title}</div>
            {draggingTask.estimated_minutes && (
              <div className="mt-1 text-xs text-neutral-500">
                ⏱ {draggingTask.estimated_minutes} хв
              </div>
            )}
          </div>
        )}
      </DragOverlay>

      <CreateTaskModal
        open={createTaskOpen}
        onClose={() => setCreateTaskOpen(false)}
        onCreated={(t) => setTasks((prev) => [t, ...prev])}
      />
    </DndContext>
  );
}
