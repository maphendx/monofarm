"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface HistoryEntry {
  id: number;
  printer_id: number;
  printer_name: string;
  file_name: string | null;
  started_at: string;
  finished_at: string | null;
  duration_minutes: number | null;
  result: string;
  filament_g: number | null;
}

const RESULT_STYLE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  cancelled: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
};

// Labels are resolved via t() at render time in the table cell

function fmt(dt: string | null): string {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dur(min: number | null): string {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}г ${m}хв` : `${m}хв`;
}

export default function HistoryPage() {
  const t = useT();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    const params = filter ? `?result=${filter}` : "";
    api<HistoryEntry[]>(`/api/history${params}`)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t("history.title")}</h1>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <option value="">{t("common.all")}</option>
          <option value="completed">{t("tasks.done")}</option>
          <option value="failed">{t("common.error")}</option>
          <option value="cancelled">{t("tasks.cancelled")}</option>
          <option value="in_progress">{t("analytics.now")}</option>
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">{t("common.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-500">{t("history.noRecords")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{t("printers.title")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("files.title")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("analytics.start")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("printers.printTime")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("analytics.title")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("filament.title")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 bg-white dark:divide-neutral-800 dark:bg-neutral-950">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <td className="px-4 py-3 font-medium">{e.printer_name}</td>
                  <td className="max-w-[220px] px-4 py-3">
                    <span className="block truncate text-neutral-600 dark:text-neutral-400" title={e.file_name ?? ""}>
                      {e.file_name ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{fmt(e.started_at)}</td>
                  <td className="px-4 py-3 text-neutral-500">{dur(e.duration_minutes)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${RESULT_STYLE[e.result] ?? ""}`}>
                      {e.result === "completed" ? `✓ ${t("tasks.done")}` : e.result === "failed" ? `✕ ${t("common.error")}` : e.result === "cancelled" ? `— ${t("tasks.cancelled")}` : e.result === "in_progress" ? t("dashboard.printing") : e.result}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-500">
                    {e.filament_g != null ? `${e.filament_g.toFixed(0)} г` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
