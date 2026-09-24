"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { History, Plus } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface SpoolLogEntry {
  id: number;
  delta_grams: number;
  grams_after: number;
  reason: string | null;
  task_id: number | null;
  created_at: string;
}

const RUN_REASON = /^print_history:(\d+):slot(\d+)$/;

/** Human label for a ledger reason; run entries link to the print history. */
function ReasonText({ reason, onClose }: { reason: string | null; onClose: () => void }) {
  const t = useT();
  if (!reason) return <span className="truncate">{t("spoolUsage.manualAdjustment")}</span>;
  const run = RUN_REASON.exec(reason);
  if (run) {
    return (
      <Link href={`/history?run_id=${run[1]}`} onClick={onClose}
        className="truncate text-[var(--accent)] hover:underline">
        {t("spoolUsage.printRun")} #{run[1]}
        <span className="text-[var(--text-faint)]"> · {t("spoolUsage.slot")} {Number(run[2]) === 254 ? t("materialStock.external") : Number(run[2]) + 1}</span>
      </Link>
    );
  }
  const task = /^Списання по задачі #(\d+)/.exec(reason);
  if (task) return <span className="truncate">{t("spoolUsage.task")} #{task[1]}</span>;
  return <span className="truncate">{reason}</span>;
}

/** Compact ledger of every gram change on a spool — runs, tasks, manual fixes. */
export function SpoolUsageSheet({ filament, onClose }: {
  filament: { id: number; material: string; color: string; hex_color: string | null };
  onClose: () => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<SpoolLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    api<SpoolLogEntry[]>(`/api/materials/${filament.id}/log`)
      .then(rows => { if (active) setEntries(rows); })
      .catch(err => { if (active) setError(err instanceof ApiError ? err.message : t("common.error")); });
    return () => { active = false; };
  }, [filament.id, reload, t]);

  const title = `${filament.material} · ${filament.color}`;

  return (
    <Modal open onClose={onClose} title={t("spoolUsage.title")} size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {error && <button type="button" className="btn btn-ghost" onClick={() => setReload(n => n + 1)}>{t("printOutput.retry")}</button>}
          <button type="button" className="btn btn-ghost ml-auto" onClick={onClose}>{t("common.close")}</button>
        </div>
      }>
      <div className="flex items-center gap-3 border-b border-[var(--border)] pb-3">
        {filament.hex_color && (
          <span className="h-8 w-8 shrink-0 rounded-full ring-1 ring-black/10"
            style={{ background: filament.hex_color }} aria-hidden />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--text)]">{title}</p>
          <p className="text-xs text-[var(--text-muted)]">{t("spoolUsage.subtitle")}</p>
        </div>
      </div>

      {!entries && !error && <p role="status" className="py-8 text-center text-sm text-[var(--text-muted)]">{t("common.loading")}</p>}
      {error && (
        <div role="alert" className="flex items-center gap-2 py-6 text-sm text-[var(--state-error)]">
          {error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReload(n => n + 1)}>{t("printOutput.retry")}</button>
        </div>
      )}

      {entries && entries.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">{t("spoolUsage.empty")}</p>
      )}

      {entries && entries.length > 0 && (
        <ul className="divide-y divide-[var(--border)]" aria-label={t("spoolUsage.title")}>
          {entries.map(entry => {
            const spent = entry.delta_grams < 0;
            return (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <span className={[
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  spent ? "bg-[rgba(239,68,68,.10)] text-[var(--state-error)]"
                        : "bg-[rgba(34,197,94,.10)] text-[var(--state-ok)]",
                ].join(" ")}>
                  {spent ? <History size={14} /> : <Plus size={14} />}
                </span>
                <div className="min-w-0 flex-1 text-xs">
                  <ReasonText reason={entry.reason} onClose={onClose} />
                  <p className="text-[10px] text-[var(--text-faint)]">
                    {new Date(entry.created_at).toLocaleString(undefined,
                      { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={[
                    "text-sm font-semibold tabular-nums",
                    spent ? "text-[var(--state-error)]" : "text-[var(--state-ok)]",
                  ].join(" ")}>
                    {spent ? "−" : "+"}{Math.abs(entry.delta_grams)}
                  </p>
                  <p className="text-[10px] tabular-nums text-[var(--text-faint)]">
                    {t("spoolUsage.left")}: {entry.grams_after} г
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
