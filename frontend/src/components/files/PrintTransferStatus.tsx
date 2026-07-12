"use client";

import { CheckCircle2, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect } from "react";

import { api } from "@/lib/api";
import { dismissPrintTransfer, updatePrintTransfer, usePrintTransfers } from "@/lib/printTransferStore";
import type { BambuCloudJob, BambuCloudJobStatus } from "@/lib/types";

const TERMINAL_STATUSES: BambuCloudJobStatus[] = ["completed", "failed", "cancelled", "lost"];

const STATUS_LABEL: Record<BambuCloudJobStatus, string> = {
  queued: "У черзі",
  validating: "Перевіряємо файл",
  creating_project: "Готуємо файл",
  uploading: "Завантажуємо на принтер",
  task_creating: "Готуємо запуск",
  task_created: "Очікуємо принтер",
  acknowledged: "Принтер прийняв файл",
  printing: "Друк",
  paused: "Пауза",
  completed: "Готово",
  failed: "Помилка",
  cancelled: "Скасовано",
  lost: "З'єднання втрачено",
};

export function PrintTransferStatus() {
  const transfers = usePrintTransfers();
  const activeJobIds = transfers
    .filter((transfer) => transfer.isActive)
    .map((transfer) => transfer.jobId)
    .join(",");

  useEffect(() => {
    const activeIds = activeJobIds ? activeJobIds.split(",").map(Number) : [];
    if (activeIds.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      await Promise.all(activeIds.map(async (jobId) => {
        try {
          const job = await api<BambuCloudJob>(`/api/bambu-jobs/${jobId}`);
          if (!cancelled) updatePrintTransfer(job);
        } catch {
          // Keep the card visible and retry; a short API hiccup is not a failed print.
        }
      }));
      if (!cancelled) timer = setTimeout(poll, 1000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobIds]);

  useEffect(() => {
    const timers = transfers
      .filter((transfer) => !transfer.isActive)
      .map((transfer) => setTimeout(() => dismissPrintTransfer(transfer.jobId), 8000));
    return () => timers.forEach(clearTimeout);
  }, [transfers]);

  if (transfers.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {transfers.map((transfer) => {
        const terminal = TERMINAL_STATUSES.includes(transfer.status);
        const failed = transfer.status === "failed" || transfer.status === "lost";
        const progress = transfer.progressPct == null ? null : Math.max(0, Math.min(100, transfer.progressPct));
        return (
          <div
            key={transfer.jobId}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,.18)]"
          >
            <div className="flex items-start gap-2">
              {terminal ? (
                failed ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--state-error)]" />
                  : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--state-ok)]" />
              ) : <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-semibold text-[var(--text-hi)]">{transfer.printerName}</p>
                  <button
                    type="button"
                    aria-label="Закрити статус"
                    onClick={() => dismissPrintTransfer(transfer.jobId)}
                    className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-hi)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="truncate text-[11px] text-[var(--text-muted)]">{transfer.fileName}</p>
                <p className={failed ? "mt-1 text-xs text-[var(--state-error)]" : "mt-1 text-xs text-[var(--text)]"}>
                  {STATUS_LABEL[transfer.status]}
                </p>
                {transfer.statusReason && (
                  <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{transfer.statusReason}</p>
                )}
                {transfer.status === "uploading" && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className={progress == null ? "h-full w-1/3 animate-pulse rounded-full bg-[var(--accent)]" : "h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"}
                      style={progress == null ? undefined : { width: `${progress}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
