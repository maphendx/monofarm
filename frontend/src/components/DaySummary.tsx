"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { FarmTask, PlanEntry } from "@/lib/types";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function DaySummary() {
  const [planDone, setPlanDone] = useState(0);
  const [planTotal, setPlanTotal] = useState(0);
  const [tasksTodo, setTasksTodo] = useState(0);
  const [tasksOverdue, setTasksOverdue] = useState(0);

  useEffect(() => {
    const today = todayStr();
    Promise.all([
      api<PlanEntry[]>(`/api/plan?plan_date=${today}`),
      api<FarmTask[]>("/api/tasks/farm"),
    ]).then(([entries, tasks]) => {
      setPlanTotal(entries.length);
      setPlanDone(entries.filter((e) => e.done).length);
      const active = tasks.filter((t) => t.status !== "done");
      setTasksTodo(active.length);
      setTasksOverdue(
        active.filter(
          (t) => t.deadline && new Date(t.deadline) < new Date(today),
        ).length,
      );
    });
  }, []);

  if (planTotal === 0 && tasksTodo === 0) return null;

  return (
    <div className="flex flex-wrap gap-3">
      {planTotal > 0 && (
        <Link
          href="/plan"
          className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <span className="text-xl">🖨️</span>
          <div>
            <div className="text-xs text-neutral-500">План друку сьогодні</div>
            <div className="text-sm font-semibold">
              {planDone}/{planTotal}{" "}
              <span className="font-normal text-neutral-500">виконано</span>
            </div>
          </div>
        </Link>
      )}

      {tasksTodo > 0 && (
        <Link
          href="/tasks"
          className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <span className="text-xl">📋</span>
          <div>
            <div className="text-xs text-neutral-500">Активних завдань</div>
            <div className="text-sm font-semibold">
              {tasksTodo}
              {tasksOverdue > 0 && (
                <span className="ml-2 text-xs font-normal text-red-600 dark:text-red-400">
                  ⚠️ {tasksOverdue} прострочено
                </span>
              )}
            </div>
          </div>
        </Link>
      )}
    </div>
  );
}
