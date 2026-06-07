"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, api } from "@/lib/api";
import type { BambuCloudJob, BambuRetryResult } from "@/lib/types";
import { Modal } from "@/components/ui/Modal";
import { BambuJobStatusBadge, bambuJobStatusLabel } from "@/components/printers/BambuJobStatusBadge";

const TIMELINE_FIELDS: { key: keyof BambuCloudJob; label: string }[] = [
  { key: "created_at", label: "Створено" },
  { key: "uploaded_at", label: "Завантажено в хмару" },
  { key: "task_created_at", label: "Завдання створено" },
  { key: "printer_ack_at", label: "Прийнято принтером" },
  { key: "started_printing_at", label: "Друк розпочато" },
  { key: "completed_at", label: "Завершено" },
  { key: "failed_at", label: "Помилка" },
  { key: "last_mqtt_at", label: "Останнє оновлення (MQTT)" },
];

function fmtDt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function BambuJobDetailModal({
  jobId,
  onClose,
  onChanged,
}: {
  jobId: number;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [job, setJob] = useState<BambuCloudJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const inFlight = useRef(false);

  async function load() {
    try {
      const j = await api<BambuCloudJob>(`/api/bambu-jobs/${jobId}`);
      setJob(j);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не вдалося завантажити завдання");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Poll while job is active — slower once terminal.
  useEffect(() => {
    const interval = job?.is_active ? 4000 : 20000;
    const t = setInterval(() => void load(), interval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.is_active]);

  async function retry() {
    if (inFlight.current || !job) return;
    inFlight.current = true;
    setBusy("retry");
    try {
      const res = await api<BambuRetryResult>(`/api/bambu-jobs/${job.id}/retry`, { method: "POST" });
      setJob(res.job);
      toast.success(res.message);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Не вдалося поставити в чергу повторно");
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  async function cancel() {
    if (inFlight.current || !job) return;
    inFlight.current = true;
    setBusy("cancel");
    setConfirmCancel(false);
    try {
      const updated = await api<BambuCloudJob>(`/api/bambu-jobs/${job.id}/cancel`, { method: "POST" });
      setJob(updated);
      toast.success("Завдання скасовано");
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Не вдалося скасувати завдання");
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  return (
    <Modal open onClose={onClose} title={job ? `Завдання #${job.id}` : "Завдання Bambu Cloud"} size="lg">
      {error && <p className="text-sm text-[var(--state-error)]">{error}</p>}
      {!job && !error && <p className="text-sm text-[var(--text-muted)]">Завантаження…</p>}
      {job && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <BambuJobStatusBadge status={job.status} />
            {job.status_reason && <span className="text-xs text-[var(--text-muted)]">{job.status_reason}</span>}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Field label="Принтер" value={job.printer_name ?? `#${job.printer_id}`} />
            <Field label="Модель" value={job.printer_model ?? "—"} />
            <Field label="Файл" value={job.file_name ?? "—"} />
            <Field label="Режим" value={job.dispatch_mode} />
            {job.progress_pct != null && <Field label="Прогрес" value={`${job.progress_pct}%`} />}
            {job.eta_minutes != null && <Field label="ETA" value={`~${job.eta_minutes} хв`} />}
            {job.bambu_task_id && <Field label="Bambu task ID" value={job.bambu_task_id} mono />}
            {job.bambu_project_id && <Field label="Bambu project ID" value={job.bambu_project_id} mono />}
            {job.retry_count > 0 && <Field label="Спроб повтору" value={String(job.retry_count)} />}
          </div>

          {job.progress_pct != null && job.is_active && (
            <div className="relative h-2 overflow-hidden rounded-sm bg-[var(--surface-hi)]">
              <div className="h-full transition-[width] duration-1000 ease-linear" style={{ background: "var(--state-print)", width: `${job.progress_pct}%` }} />
            </div>
          )}

          {job.error_message && (
            <div className="rounded-md border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] px-3 py-2.5 text-sm text-[var(--state-error)]">
              {job.error_message}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">Хронологія</p>
            <ul className="space-y-1.5">
              {TIMELINE_FIELDS.map(({ key, label }) => {
                const value = job[key] as string | null;
                if (!value) return null;
                return (
                  <li key={key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-[var(--text-muted)]">{label}</span>
                    <span className="font-mono text-xs text-[var(--text)]">{fmtDt(value)}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
            {job.can_retry && (
              <button onClick={() => void retry()} disabled={busy !== null} className="btn btn-primary disabled:opacity-40">
                {busy === "retry" ? "…" : "Повторити"}
              </button>
            )}
            {job.is_active && (
              confirmCancel ? (
                <div className="flex items-center gap-2 rounded-md border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] px-3 py-2">
                  <span className="text-xs text-[var(--state-error)]">Скасувати завдання?</span>
                  <button onClick={() => void cancel()} disabled={busy !== null} className="text-xs font-bold text-[var(--state-error)] hover:underline disabled:opacity-40">
                    {busy === "cancel" ? "…" : "Так"}
                  </button>
                  <span className="text-[var(--text-muted)]">·</span>
                  <button onClick={() => setConfirmCancel(false)} className="text-xs text-[var(--text-muted)] hover:underline">Ні</button>
                </div>
              ) : (
                <button onClick={() => setConfirmCancel(true)} disabled={busy !== null}
                  className="rounded-md border border-[var(--state-error)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-xs font-medium text-[var(--state-error)] transition hover:bg-[rgba(239,68,68,.15)] disabled:opacity-40">
                  Скасувати
                </button>
              )
            )}
            {!job.can_retry && !job.is_active && (
              <span className="text-xs text-[var(--text-faint)]">
                {bambuJobStatusLabel(job.status)} · дій недоступно
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-[var(--text-faint)]">{label}</p>
      <p className={`truncate ${mono ? "font-mono text-xs" : "text-sm"} text-[var(--text)]`} title={value}>{value}</p>
    </div>
  );
}
