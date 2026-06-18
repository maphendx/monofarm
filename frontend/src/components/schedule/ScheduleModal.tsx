"use client";

import { useState, useEffect } from "react";
import type { CalendarEntry, PrintTask, Printer, ScheduleMode } from "@/lib/types";
import { Modal } from "@/components/ui/Modal";
import { createPlanEntry, updatePlanEntry, deletePlanEntry } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { useConfirm } from "@/hooks/useConfirm";
import { fmtDuration } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleModalMode =
  | { type: "schedule"; task: PrintTask }
  | { type: "edit"; entry: CalendarEntry };

interface Props {
  mode: ScheduleModalMode | null;
  printers: Printer[];
  onClose: () => void;
  onSaved: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addMinutesToTime(value: string, minutes: number | null | undefined): string | null {
  if (!value || !minutes || minutes <= 0) return null;
  const [hours, mins] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  const total = hours * 60 + mins + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const daySuffix = total >= 1440 ? " +1д" : "";
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}${daySuffix}`;
}

const MODE_LABELS: Record<ScheduleMode, string> = {
  asap: "ASAP — без конкретного часу",
  not_before: "Не раніше ніж",
  exact_time: "Точний час",
  window: "Часове вікно",
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ScheduleModal({ mode, printers, onClose, onSaved }: Props) {
  const isOpen  = mode !== null;
  const isEdit  = mode?.type === "edit";
  const entry   = isEdit ? (mode as { type: "edit"; entry: CalendarEntry }).entry : null;
  const task    = mode?.type === "schedule"
    ? (mode as { type: "schedule"; task: PrintTask }).task
    : entry?.task ?? null;

  // ── form state ──
  const [printerId,    setPrinterId]    = useState<number | "">("");
  const [planDate,     setPlanDate]     = useState(todayIso());
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("asap");
  const [startTime,    setStartTime]    = useState("");

  const [saving,  setSaving]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // Pre-fill when editing
  useEffect(() => {
    if (!isOpen) return;
    if (isEdit && entry) {
      setPrinterId(entry.printer_id);
      setPlanDate(entry.plan_date);
      setScheduleMode((entry.schedule_mode as ScheduleMode) ?? "asap");
      setStartTime(entry.start_time ? entry.start_time.slice(0, 5) : "");
    } else {
      // New schedule: default to first printer, today, asap
      setPrinterId(printers[0]?.id ?? "");
      setPlanDate(todayIso());
      setScheduleMode("asap");
      setStartTime("");
    }
    setError(null);
  }, [isOpen, isEdit, entry, printers]);

  if (!isOpen || !task) return null;

  // ── actions ──

  async function handleSave() {
    if (!printerId) { setError("Оберіть принтер"); return; }
    if (!isEdit && !task) { setError("Завдання не вибрано"); return; }
    setSaving(true);
    setError(null);
    try {
      const startTimeVal = scheduleMode !== "asap" && startTime ? `${startTime}:00` : null;

      if (isEdit && entry) {
        await updatePlanEntry(entry.id, {
          plan_date: planDate,
          printer_id: Number(printerId),
          start_time: startTimeVal,
          schedule_mode: scheduleMode,
        });
      } else if (task) {
        await createPlanEntry({
          plan_date: planDate,
          printer_id: Number(printerId),
          task_id: task.id,
          start_time: startTimeVal,
          schedule_mode: scheduleMode,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка збереження");
    } finally {
      setSaving(false);
    }
  }

  async function handleUnschedule() {
    if (!entry) return;
    setSaving(true);
    setError(null);
    try {
      // PATCH reset: keep PlanEntry assignment but clear specific time
      await updatePlanEntry(entry.id, { start_time: null, schedule_mode: "asap" });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!entry) return;
    if (!await confirm({ message: `Зняти «${task?.title ?? "завдання"}» з плану (залишиться в черзі)?`, variant: "warn" })) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePlanEntry(entry.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка видалення");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteTask() {
    if (!task) return;
    if (!await confirm({ message: `Видалити задачу «${task.title ?? "завдання"}» повністю з системи (включаючи файл)?`, variant: "danger" })) return;
    setDeleting(true);
    setError(null);
    try {
      const { api } = await import("@/lib/api");
      await api(`/api/queue/${task.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка видалення задачі");
    } finally {
      setDeleting(false);
    }
  }

  const title = isEdit ? "Змінити розклад" : "Запланувати друк";
  const duration = task.estimated_minutes ?? task.filament_meta?.estimated_minutes ?? null;
  const finishTime = scheduleMode !== "asap" ? addMinutesToTime(startTime, duration) : null;

  return (
    <>
    <Modal
      open={isOpen}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="flex w-full items-center gap-2">
          {/* Destructive actions — edit mode only */}
          {isEdit && entry && (
            <>
              {entry.start_time && (
                <button
                  type="button"
                  onClick={handleUnschedule}
                  disabled={saving || deleting}
                  className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50"
                  title="Скинути точний час"
                >
                  Скинути час
                </button>
              )}
              <button
                type="button"
                onClick={handleRemove}
                disabled={saving || deleting}
                className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)] disabled:opacity-50"
                title="Зняти з розкладу (повернеться в чергу)"
              >
                {deleting ? "Обробка…" : "Зняти з плану"}
              </button>
              <button
                type="button"
                onClick={handleDeleteTask}
                disabled={saving || deleting}
                className="rounded border border-[rgba(239,68,68,.3)] bg-[rgba(239,68,68,.07)] px-3 py-1.5 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.12)] disabled:opacity-50"
                title="Видалити повністю з черги"
              >
                {deleting ? "Видалення…" : "Видалити задачу"}
              </button>
            </>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
          >
            Скасувати
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || deleting}
            className="rounded bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Збереження…" : isEdit ? "Зберегти" : "Запланувати"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Task info */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
          <p className="text-xs font-medium text-[var(--text)]">{task.file_name ?? task.title}</p>
          <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">
            {[task.filament_type, task.filament_color].filter(Boolean).join(" · ")}
            {task.estimated_minutes ? ` · ${Math.floor(task.estimated_minutes / 60)}г ${task.estimated_minutes % 60}хв` : ""}
          </p>
        </div>

        {error && (
          <p className="rounded border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-xs text-[var(--state-error)]">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          {/* Printer selector */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Принтер
            </span>
            <select
              value={printerId}
              onChange={e => setPrinterId(Number(e.target.value))}
              className="h-8 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              <option value="">— оберіть —</option>
              {printers.filter(p => p.is_active).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* Date */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Дата
            </span>
            <input
              type="date"
              value={planDate}
              onChange={e => setPlanDate(e.target.value)}
              className="h-8 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
        </div>

        {/* Schedule mode */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Режим
          </span>
          <select
            value={scheduleMode}
            onChange={e => setScheduleMode(e.target.value as ScheduleMode)}
            className="h-8 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          >
            {(Object.entries(MODE_LABELS) as [ScheduleMode, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>

        {/* Start time — shown when mode requires it */}
        {scheduleMode !== "asap" && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {scheduleMode === "not_before" ? "Не раніше (час)" : "Час початку"}
            </span>
            <input
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className="h-8 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </label>
        )}

        {finishTime && (
          <div className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-muted)]">
            Завершення: <span className="font-medium tabular-nums text-[var(--text)]">{finishTime}</span>
            {duration ? <span className="text-[var(--text-faint)]"> · {fmtDuration(duration)}</span> : null}
          </div>
        )}
      </div>
    </Modal>
    {dialog}
    </>
  );
}
