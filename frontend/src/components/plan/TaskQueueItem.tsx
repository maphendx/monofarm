"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import { FilamentSwatches } from "@/components/FilamentSwatches";
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
        "group relative cursor-grab rounded-lg border bg-[var(--bg-elevated)] p-3 shadow-sm active:cursor-grabbing" +
        (isDragging
          ? " border-[var(--border-strong)] opacity-50 ring-2 ring-[var(--border-strong)]"
          : " border-[var(--border)] hover:border-[var(--border-strong)]")
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
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
        {task.quantity > 1 && <span>×{task.quantity}</span>}
        {!task.filament_meta?.types?.length && task.filament_type && (
          <span>
            {task.filament_type}
            {task.filament_color ? ` · ${task.filament_color}` : ""}
          </span>
        )}
        {task.estimated_minutes && (
          <span>⏱ {formatEta(task.estimated_minutes)}</span>
        )}
        {task.deadline && (
          <span className="text-[var(--state-warn)]">
            🗓 {task.deadline}
          </span>
        )}
        {task.file_name && (
          <span className="rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[10px] text-[var(--accent)]">
            📎 {task.file_name}
          </span>
        )}
      </div>
      {task.filament_meta && (
        <div className="mt-1.5">
          <FilamentSwatches meta={task.filament_meta} />
        </div>
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(task.id);
        }}
        className="absolute right-2 top-2 hidden rounded p-0.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-red-500 group-hover:flex"
        aria-label="Видалити задачу"
      >
        ✕
      </button>
    </div>
  );
}
