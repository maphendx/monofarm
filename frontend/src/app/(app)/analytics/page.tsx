"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "@/lib/api";

interface Summary {
  tasks: { queued: number; in_progress: number; done: number; cancelled: number };
  plan_entries_done: number;
  total_print_minutes: number;
  total_filament_g: number;
  active_printers: number;
}

interface DailyPoint {
  date: string;
  done: number;
}

interface PrinterStat {
  id: number;
  name: string;
  kind: string;
  total_entries: number;
  done_entries: number;
  estimated_minutes_done: number;
}

interface FilamentUsage {
  by_material: { material: string; grams: number }[];
}

function fmtHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}хв`;
  return m === 0 ? `${h}год` : `${h}год ${m}хв`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}`;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-sm text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-neutral-400">{sub}</p>}
    </div>
  );
}

const MATERIAL_COLORS: Record<string, string> = {
  PLA: "#3b82f6",
  PETG: "#10b981",
  ABS: "#f59e0b",
  TPU: "#8b5cf6",
  ASA: "#ef4444",
  PA: "#06b6d4",
};

function materialColor(m: string) {
  return MATERIAL_COLORS[m.toUpperCase()] ?? "#94a3b8";
}

export default function AnalyticsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [printers, setPrinters] = useState<PrinterStat[]>([]);
  const [filament, setFilament] = useState<FilamentUsage | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<Summary>("/api/analytics/summary"),
      api<DailyPoint[]>(`/api/analytics/daily?days=${days}`),
      api<PrinterStat[]>("/api/analytics/printers"),
      api<FilamentUsage>("/api/analytics/filament-usage"),
    ])
      .then(([s, d, p, f]) => {
        setSummary(s);
        setDaily(d);
        setPrinters(p);
        setFilament(f);
      })
      .finally(() => setLoading(false));
  }, [days]);

  if (loading) {
    return <p className="text-sm text-neutral-500">Завантаження…</p>;
  }

  const maxDone = Math.max(...daily.map((d) => d.done), 1);

  return (
    <div className="space-y-8">
      <h1 className="text-lg font-semibold">Аналітика</h1>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Надруковано завдань"
            value={summary.plan_entries_done}
            sub={`у черзі: ${summary.tasks.queued}`}
          />
          <StatCard
            label="Час друку"
            value={fmtHours(summary.total_print_minutes)}
            sub="за весь час"
          />
          <StatCard
            label="Пластик використано"
            value={`${summary.total_filament_g} г`}
            sub={`≈ ${(summary.total_filament_g / 1000).toFixed(2)} кг`}
          />
          <StatCard
            label="Активних принтерів"
            value={summary.active_printers}
          />
        </div>
      )}

      {/* Daily chart */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">Виконано завдань по днях</h2>
          <div className="flex gap-1">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={
                  "rounded px-2.5 py-1 text-xs transition " +
                  (days === d
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800")
                }
              >
                {d}д
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={daily} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="opacity-10" />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDate}
              tick={{ fontSize: 11 }}
              interval={Math.floor(daily.length / 7)}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} domain={[0, maxDone + 1]} />
            <Tooltip
              formatter={(v: number) => [v, "виконано"]}
              labelFormatter={fmtDate}
              contentStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="done" radius={[4, 4, 0, 0]} fill="#171717" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Printer stats */}
        <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="mb-4 font-medium">Принтери — топ активності</h2>
          {printers.length === 0 ? (
            <p className="text-sm text-neutral-400">Немає даних</p>
          ) : (
            <div className="space-y-3">
              {printers.slice(0, 10).map((p) => {
                const pct = p.total_entries > 0 ? (p.done_entries / p.total_entries) * 100 : 0;
                return (
                  <div key={p.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="ml-2 shrink-0 text-neutral-500">
                        {p.done_entries}/{p.total_entries}
                        {p.estimated_minutes_done > 0 && (
                          <span className="ml-2 text-xs text-neutral-400">
                            {fmtHours(p.estimated_minutes_done)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-neutral-900 dark:bg-neutral-100 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Filament usage */}
        <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="mb-4 font-medium">Пластик за матеріалом</h2>
          {!filament || filament.by_material.length === 0 ? (
            <p className="text-sm text-neutral-400">Немає даних</p>
          ) : (
            <div className="space-y-3">
              {filament.by_material.map((row) => {
                const total = filament.by_material.reduce((s, r) => s + r.grams, 0);
                const pct = total > 0 ? (row.grams / total) * 100 : 0;
                const color = materialColor(row.material);
                return (
                  <div key={row.material}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: color }}
                        />
                        {row.material}
                      </span>
                      <span className="text-neutral-500">
                        {row.grams >= 1000
                          ? `${(row.grams / 1000).toFixed(2)} кг`
                          : `${row.grams} г`}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Task status breakdown */}
      {summary && (
        <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="mb-4 font-medium">Завдання друку — розподіл</h2>
          <div className="flex flex-wrap gap-4">
            {[
              { key: "queued", label: "В черзі", color: "bg-neutral-400" },
              { key: "in_progress", label: "В процесі", color: "bg-amber-400" },
              { key: "done", label: "Виконано", color: "bg-emerald-400" },
              { key: "cancelled", label: "Скасовано", color: "bg-red-300" },
            ].map(({ key, label, color }) => {
              const count = summary.tasks[key as keyof typeof summary.tasks];
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${color}`} />
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">{label}:</span>
                  <span className="text-sm font-semibold">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
