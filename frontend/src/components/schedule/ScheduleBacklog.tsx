"use client";

import { useState } from "react";
import type { PrintTask } from "@/lib/types";
import { fmtDuration } from "./utils";

function BacklogItem({
  task,
  onSchedule,
}: {
  task: PrintTask;
  onSchedule: (t: PrintTask) => void;
}) {
  const duration = task.estimated_minutes;
  const material = [task.filament_type, task.filament_color].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={() => onSchedule(task)}
      className="group w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-2.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-xs font-medium text-[var(--text)] group-hover:text-[var(--accent)]">
          {task.file_name ?? task.title}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-faint)]">
        {duration != null && duration > 0 && (
          <span className="tabular-nums">{fmtDuration(duration)}</span>
        )}
        {material && <span>{material}</span>}
        {task.quantity > 1 && <span>×{task.quantity}</span>}
      </div>

      <div className="mt-1.5 text-[9px] text-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-100">
        Натисніть щоб запланувати →
      </div>
    </button>
  );
}

export function ScheduleBacklog({
  tasks,
  onSchedule,
}: {
  tasks: PrintTask[];
  onSchedule: (task: PrintTask) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? tasks.filter(t => {
        const q = search.toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          (t.file_name ?? "").toLowerCase().includes(q) ||
          (t.filament_type ?? "").toLowerCase().includes(q)
        );
      })
    : tasks;

  return (
    <div className="flex h-full flex-col">
      {/* Panel header */}
      <div className="border-b border-[var(--border)] px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-[var(--text)]">Бекло</span>
          <span className="text-[10px] text-[var(--text-faint)]">
            {tasks.length} незаплановано
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">
          Задачі без часу в поточному тижні
        </p>
      </div>

      {/* Search */}
      <div className="border-b border-[var(--border)] px-3 py-2">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Пошук…"
          className="h-7 w-full rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)] placeholder-[var(--text-faint)] outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--text-faint)]">
            {tasks.length === 0
              ? "Всі задачі заплановані"
              : "Нічого не знайдено"}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map(task => (
              <BacklogItem key={task.id} task={task} onSchedule={onSchedule} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
