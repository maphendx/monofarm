"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { usePageTitle } from "@/lib/usePageTitle";

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
  completed: "bg-[rgba(34,197,94,.10)] text-[var(--state-ok)]  dark:text-[var(--state-ok)]",
  failed: "bg-[rgba(239,68,68,.10)] text-[var(--state-error)]",
  cancelled: "bg-[var(--surface-hi)] text-[var(--text-muted)]",
  in_progress: "bg-[rgba(56,189,248,.10)] text-[var(--accent)]",
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
  usePageTitle("nav.history");
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
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm  "
        >
          <option value="">{t("common.all")}</option>
          <option value="completed">{t("tasks.done")}</option>
          <option value="failed">{t("common.error")}</option>
          <option value="cancelled">{t("tasks.cancelled")}</option>
          <option value="in_progress">{t("analytics.now")}</option>
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t("history.noRecords")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] ">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-xs text-[var(--text-muted)]  ">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{t("printers.title")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("files.title")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("analytics.start")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("printers.printTime")}</th>
                <th className="px-4 py-3 text-left font-medium">{t("analytics.title")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("filament.title")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--bg-elevated)] dark:divide-neutral-800 ">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-[var(--surface-hi)] ">
                  <td className="px-4 py-3 font-medium">{e.printer_name}</td>
                  <td className="max-w-[220px] px-4 py-3">
                    <span className="block truncate text-[var(--text-muted)] " title={e.file_name ?? ""}>
                      {e.file_name ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">{fmt(e.started_at)}</td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">{dur(e.duration_minutes)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${RESULT_STYLE[e.result] ?? ""}`}>
                      {e.result === "completed" ? `✓ ${t("tasks.done")}` : e.result === "failed" ? `✕ ${t("common.error")}` : e.result === "cancelled" ? `— ${t("tasks.cancelled")}` : e.result === "in_progress" ? t("dashboard.printing") : e.result}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text-muted)]">
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
