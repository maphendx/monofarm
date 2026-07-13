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
import { useT } from "@/lib/i18n";
import { usePageTitle } from "@/lib/usePageTitle";
import { PageSkeleton } from "@/components/ui/ContentSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";

interface Summary {
  tasks: { queued: number; in_progress: number; done: number; cancelled: number };
  plan_entries_done: number;
  total_print_minutes: number;
  total_filament_g: number;
  active_printers: number;
  total_material_cost_uah: number;
  total_pieces_ok: number;
  total_pieces_defective: number;
  defect_rate_pct: number;
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
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
      <p className="text-sm text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--text-faint)]">{sub}</p>}
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
  usePageTitle("nav.analytics");
  const t = useT();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [printers, setPrinters] = useState<PrinterStat[]>([]);
  const [filament, setFilament] = useState<FilamentUsage | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
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
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [days]);

  if (loading) return <PageSkeleton cols={5} withStats statsCount={5} />;

  if (error) {
    return (
      <div className="space-y-8">
        <h1 className="text-lg font-semibold">{t("analytics.title")}</h1>
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>}
          title={t("analytics.loadError")}
          description={t("analytics.loadErrorHint")}
        />
      </div>
    );
  }

  const isEmpty = summary != null
    && summary.plan_entries_done === 0
    && summary.total_print_minutes === 0
    && summary.active_printers === 0;

  if (isEmpty) {
    return (
      <div className="space-y-8">
        <h1 className="text-lg font-semibold">{t("analytics.title")}</h1>
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>}
          title={t("analytics.noData")}
          description={t("analytics.noDataHint")}
          action={{ label: t("printers.add"), href: "/settings" }}
        />
      </div>
    );
  }

  const maxDone = Math.max(...daily.map((d) => d.done), 1);

  return (
    <div className="space-y-8">
      <h1 className="text-lg font-semibold">{t("analytics.title")}</h1>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label={t("analytics.printedJobs")}
            value={summary.plan_entries_done}
            sub={`${t("tasks.queue")}: ${summary.tasks.queued}`}
          />
          <StatCard
            label={t("printers.printTime")}
            value={fmtHours(summary.total_print_minutes)}
            sub={t("history.allTime")}
          />
          <StatCard
            label={t("files.filamentUsed")}
            value={`${summary.total_filament_g} г`}
            sub={`≈ ${(summary.total_filament_g / 1000).toFixed(2)} кг`}
          />
          <StatCard
            label={t("dashboard.activePrinters")}
            value={summary.active_printers}
          />
          <StatCard
            label={t("analytics.materialCost")}
            value={`${summary.total_material_cost_uah.toFixed(0)} ₴`}
          />
          <StatCard
            label={t("analytics.defectRate")}
            value={`${summary.defect_rate_pct}%`}
            sub={`${summary.total_pieces_ok}/${summary.total_pieces_ok + summary.total_pieces_defective} ${t("analytics.ok")}`}
          />
        </div>
      )}

      {/* Daily chart */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">{t("analytics.completedByDay")}</h2>
          <div className="flex gap-1">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={
                  "rounded px-2.5 py-1 text-xs transition " +
                  (days === d
                    ? "bg-[var(--accent)] text-white  "
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] ")
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
              formatter={(v) => [v, t("history.completed")]}
              labelFormatter={(label) => fmtDate(String(label))}
              contentStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="done" radius={[4, 4, 0, 0]} fill="#171717" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Printer stats */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <h2 className="mb-4 font-medium">{t("analytics.topPrinters")}</h2>
          {printers.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">{t("analytics.noData")}</p>
          ) : (
            <div className="space-y-3">
              {printers.slice(0, 10).map((p) => {
                const pct = p.total_entries > 0 ? (p.done_entries / p.total_entries) * 100 : 0;
                return (
                  <div key={p.id}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="ml-2 shrink-0 text-[var(--text-muted)]">
                        {p.done_entries}/{p.total_entries}
                        {p.estimated_minutes_done > 0 && (
                          <span className="ml-2 text-xs text-[var(--text-faint)]">
                            {fmtHours(p.estimated_minutes_done)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-hi)] ">
                      <div
                        className="h-full rounded-full bg-[var(--surface)]  transition-[width]"
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
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <h2 className="mb-4 font-medium">{t("analytics.filamentByMaterial")}</h2>
          {!filament || filament.by_material.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">{t("analytics.noData")}</p>
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
                      <span className="text-[var(--text-muted)]">
                        {row.grams >= 1000
                          ? `${(row.grams / 1000).toFixed(2)} кг`
                          : `${row.grams} г`}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-hi)] ">
                      <div
                        className="h-full rounded-full transition-[width,background-color]"
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
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5  ">
          <h2 className="mb-4 font-medium">Завдання друку — розподіл</h2>
          <div className="flex flex-wrap gap-4">
            {[
              { key: "queued", label: "В черзі", color: "bg-[var(--state-idle)]" },
              { key: "in_progress", label: "В процесі", color: "bg-[var(--state-warn)]" },
              { key: "done", label: "Виконано", color: "bg-[var(--state-ok)]" },
              { key: "cancelled", label: "Скасовано", color: "bg-[var(--state-error)]" },
            ].map(({ key, label, color }) => {
              const count = summary.tasks[key as keyof typeof summary.tasks];
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${color}`} />
                  <span className="text-sm text-[var(--text-muted)] ">{label}:</span>
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
