"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import type { PrintTask } from "@/lib/types";

function formatEta(min: number | null) {
  if (!min) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}г ${m ? m + "хв" : ""}`.trim() : `${m}хв`;
}

export function TaskQueueItem({
  task,
  assignedCount = 0,
  onDelete,
}: {
  task: PrintTask;
  assignedCount?: number;
  onDelete: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: `task-${task.id}`, data: { task } });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={
        "group relative cursor-grab rounded-lg border bg-white p-3 shadow-sm active:cursor-grabbing dark:bg-neutral-900 " +
        (isDragging
          ? "border-neutral-400 opacity-50 ring-2 ring-neutral-400"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500")
      }
    >
      <div className="flex items-start justify-between gap-1 pr-5">
        <span className="text-sm font-medium leading-tight">{task.title}</span>
        {assignedCount > 0 && (
          <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            ✓×{assignedCount}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-500">
        {task.quantity > 1 && <span>×{task.quantity}</span>}
        {task.filament_type && (
          <span>
            {task.filament_type}
            {task.filament_color ? ` · ${task.filament_color}` : ""}
          </span>
        )}
        {task.estimated_minutes && (
          <span>⏱ {formatEta(task.estimated_minutes)}</span>
        )}
        {task.deadline && (
          <span className="text-amber-600 dark:text-amber-400">
            🗓 {task.deadline}
          </span>
        )}
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(task.id);
        }}
        className="absolute right-2 top-2 hidden rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-500 group-hover:flex dark:hover:bg-neutral-800"
        aria-label="Видалити задачу"
      >
        ✕
      </button>
    </div>
  );
}
