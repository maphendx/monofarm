"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { FarmTask, Filament, PlanEntry } from "@/lib/types";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function DaySummary() {
  const [planDone, setPlanDone] = useState(0);
  const [planTotal, setPlanTotal] = useState(0);
  const [tasksTodo, setTasksTodo] = useState(0);
  const [tasksOverdue, setTasksOverdue] = useState(0);
  const [lowFilament, setLowFilament] = useState(0);

  useEffect(() => {
    const today = todayStr();
    Promise.all([
      api<PlanEntry[]>(`/api/plan?plan_date=${today}`),
      api<FarmTask[]>("/api/tasks/farm"),
      api<Filament[]>("/api/materials"),
    ]).then(([entries, tasks, filaments]) => {
      setPlanTotal(entries.length);
      setPlanDone(entries.filter((e) => e.done).length);
      const active = tasks.filter((t) => t.status !== "done");
      setTasksTodo(active.length);
      setTasksOverdue(
        active.filter(
          (t) => t.deadline && new Date(t.deadline) < new Date(today),
        ).length,
      );
      setLowFilament(filaments.filter((f) => f.is_low).length);
    });
  }, []);

  if (planTotal === 0 && tasksTodo === 0 && lowFilament === 0) return null;

  return (
    <div className="flex flex-wrap gap-3">
      {planTotal > 0 && (
        <Link
          href="/plan"
          className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 shadow-sm hover:border-[var(--border-strong)]  "
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="18" width="12" height="4" rx="1"/></svg>
          <div>
            <div className="text-xs text-[var(--text-muted)]">План друку сьогодні</div>
            <div className="text-sm font-semibold">
              {planDone}/{planTotal}{" "}
              <span className="font-normal text-[var(--text-muted)]">виконано</span>
            </div>
          </div>
        </Link>
      )}

      {tasksTodo > 0 && (
        <Link
          href="/tasks"
          className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 shadow-sm hover:border-[var(--border-strong)]  "
        >
          <span className="text-xl">📋</span>
          <div>
            <div className="text-xs text-[var(--text-muted)]">Активних завдань</div>
            <div className="text-sm font-semibold">
              {tasksTodo}
              {tasksOverdue > 0 && (
                <span className="ml-2 text-xs font-normal text-[var(--state-error)]">
                  ⚠️ {tasksOverdue} прострочено
                </span>
              )}
            </div>
          </div>
        </Link>
      )}

      {lowFilament > 0 && (
        <Link
          href="/materials"
          className="flex items-center gap-2 rounded-xl border border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.08)] px-4 py-3 shadow-sm hover:border-[var(--state-warn)]"
        >
          <span className="text-xl">⚠️</span>
          <div>
            <div className="text-xs text-[var(--state-warn)]">
              Пластик закінчується
            </div>
            <div className="text-sm font-semibold text-[var(--state-warn)]">
              {lowFilament}{" "}
              <span className="font-normal">{lowFilament === 1 ? "котушка" : "котушок"}</span>
            </div>
          </div>
        </Link>
      )}
    </div>
  );
}
