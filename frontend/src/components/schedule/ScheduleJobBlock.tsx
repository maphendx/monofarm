"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { CalendarBlock } from "./utils";
import { fmtTimeMins, fmtDuration } from "./utils";
import { API_URL } from "@/lib/api";

function JobPopover({ block, rect }: { block: CalendarBlock; rect: DOMRect }) {
  const { entry, startMins, endMins, totalDurationMins } = block;
  const task = entry.task;
  const startLabel = fmtTimeMins(startMins);
  const endLabel = fmtTimeMins(endMins % 1440);
  const thumbSrc = task.has_thumbnail && task.gcode_file_id
    ? `${API_URL}/api/files/${task.gcode_file_id}/thumbnail` : null;
  const meta = task.filament_meta;
  const statusLabel = task.status === "done" ? "✓ Завершено"
    : task.status === "cancelled" ? "⊘ Скасовано"
    : task.status === "in_progress" ? "● Друкується"
    : "○ Заплановано";
  const statusCls = task.status === "done" ? "text-[var(--state-ok)]"
    : task.status === "cancelled" ? "text-[var(--state-error)]"
    : task.status === "in_progress" ? "text-[var(--state-print)]"
    : "text-[var(--accent)]";

  const top = rect.bottom + 6;
  const left = Math.min(rect.left, window.innerWidth - 300);

  return createPortal(
    <div
      className="fixed z-[9999] w-[290px] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-xl"
      style={{ top, left, maxHeight: 360, overflowY: "auto" }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="flex gap-3 border-b border-[var(--border)] px-4 py-3">
        {thumbSrc ? (
          <img src={thumbSrc} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hi)] text-xs font-bold text-[var(--text-faint)]">
            {(task.file_name ?? "").endsWith(".3mf") ? "3MF" : "GC"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold leading-tight text-[var(--text-hi)]">{task.file_name ?? task.title}</p>
          {task.title !== (task.file_name ?? task.title) && (
            <p className="mt-0.5 truncate text-[10px] text-[var(--text-faint)]">{task.title}</p>
          )}
          <p className={`mt-1 text-[10px] font-medium ${statusCls}`}>{statusLabel}</p>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div><span className="text-[var(--text-faint)]">Час</span> <span className="font-medium text-[var(--text)]">{startLabel} → {endLabel}</span></div>
          <div><span className="text-[var(--text-faint)]">Тривалість</span> <span className="font-medium text-[var(--text)]">{fmtDuration(totalDurationMins)}</span></div>
          {task.quantity > 1 && (
            <div><span className="text-[var(--text-faint)]">Кількість</span> <span className="font-medium text-[var(--text)]">×{task.quantity}</span></div>
          )}
          {entry.runs_total > 1 && (
            <div><span className="text-[var(--text-faint)]">AutoPrint</span> <span className="font-medium text-[var(--text)]">{entry.runs_completed}/{entry.runs_total}</span></div>
          )}
          {task.estimated_minutes && (
            <div><span className="text-[var(--text-faint)]">Оцінка</span> <span className="font-medium text-[var(--text)]">{fmtDuration(task.estimated_minutes)}</span></div>
          )}
        </div>
        {meta && (meta.types?.length || meta.colors?.length) && (
          <div className="flex flex-wrap gap-1 pt-1 border-t border-[var(--border)]/50">
            {(meta.colors ?? []).map((c: string, i: number) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px text-[9px] text-[var(--text-muted)]">
                <span className="h-2 w-2 shrink-0 rounded-full border border-white/20" style={{ background: c }} />
                {meta.types?.[i] ?? ""}
              </span>
            ))}
            {meta.used_g && meta.used_g.length > 0 && (
              <span className="self-center text-[9px] text-[var(--text-faint)]">
                {Math.round(meta.used_g.reduce((s: number, g: number) => s + g, 0))} г
              </span>
            )}
          </div>
        )}
        {entry.conflict && (
          <div className="rounded bg-[var(--state-warn)]/10 px-2 py-1 text-[10px] font-medium text-[var(--state-warn)]">⚠ Конфлікт з іншим друком</div>
        )}
        {entry.blocked_reason && (
          <div className="rounded bg-[var(--state-idle)]/10 px-2 py-1 text-[10px] text-[var(--text-muted)]">⊘ {entry.blocked_reason}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ScheduleJobBlock({
  block,
  onClick,
  onSend,
  sendDisabledReason,
  onDelete,
}: {
  block: CalendarBlock;
  onClick: () => void;
  onSend?: () => void;
  sendDisabledReason?: string;
  onDelete?: () => void;
}) {
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const { entry, startMins, endMins, isContinuation, totalDurationMins } = block;
  const isConflict = entry.conflict;
  const isBlocked  = !!entry.blocked_reason && entry.schedule_mode !== "asap";
  const status = entry.task.status;

  const leftPct   = (startMins / 1440) * 100;
  const widthPct  = ((endMins - startMins) / 1440) * 100;
  const minWidthPx = 48;
  const isOverflow = endMins > 1440;

  const isCompact = widthPct < 5;

  const startLabel = fmtTimeMins(startMins);
  const endLabel   = fmtTimeMins(endMins % 1440);
  const timeLabel  = isContinuation
    ? `до ${endLabel}`
    : endMins > startMins
    ? `${startLabel}–${endLabel}${isOverflow ? "↗" : ""}`
    : startLabel;
  const durationLabel = fmtDuration(totalDurationMins);
  const fileLabel  = entry.task.file_name ?? entry.task.title;
  const thumbSrc   = entry.task.has_thumbnail && entry.task.gcode_file_id
    ? `${API_URL}/api/files/${entry.task.gcode_file_id}/thumbnail`
    : null;

  const base =
    "absolute rounded cursor-pointer select-none transition-opacity hover:opacity-90 active:opacity-75";

  const statusTone = status === "done" ? "done"
    : status === "cancelled" ? "cancelled"
    : status === "in_progress" ? "printing"
    : "queued";

  const colorCls = isConflict
    ? "bg-[rgba(217,119,6,.18)] border border-[rgba(217,119,6,.45)]"
    : isBlocked
    ? "bg-[rgba(113,113,122,.14)] border border-[rgba(113,113,122,.35)]"
    : statusTone === "done"
    ? "bg-[rgba(34,197,94,.10)] border border-[rgba(34,197,94,.36)]"
    : statusTone === "cancelled"
    ? "bg-[rgba(239,68,68,.09)] border border-[rgba(239,68,68,.34)]"
    : statusTone === "printing"
    ? "bg-[rgba(56,189,248,.10)] border border-[rgba(56,189,248,.36)]"
    : isContinuation
    ? "bg-[var(--accent-soft)] border border-dashed border-[var(--accent)]"
    : "bg-[var(--accent-soft)] border border-[var(--accent)]";

  const topBorder = !isContinuation
    ? isConflict ? "border-t-[3px] border-t-[var(--state-warn)]"
      : isBlocked ? "border-t-[3px] border-t-[var(--state-idle)]"
      : statusTone === "done" ? "border-t-[3px] border-t-[var(--state-ok)]"
      : statusTone === "cancelled" ? "border-t-[3px] border-t-[var(--state-error)]"
      : statusTone === "printing" ? "border-t-[3px] border-t-[var(--state-print)]"
      : "border-t-[3px] border-t-[var(--accent)]"
    : "";

  function onDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "block", entryId: entry.id }));
    const fname = entry.task.file_name ?? "";
    const is3mf = fname.toLowerCase().endsWith(".3mf");
    e.dataTransfer.setData(is3mf ? "application/x-3mf" : "application/x-gcode", "1");
    e.dataTransfer.setData(`application/x-duration-${Math.max(1, totalDurationMins)}`, "1");
    e.dataTransfer.setData(`application/x-entry-${entry.id}`, "1");
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ left: `${leftPct}%`, width: `max(${minWidthPx}px, ${widthPct}%)`, top: "40%", height: "28%", minHeight: "18px", zIndex: popoverRect ? 40 : isOverflow ? 8 : 4, overflow: "hidden" }}
      className={`group ${base} ${colorCls} ${topBorder}`}
      onMouseEnter={e => setPopoverRect(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setPopoverRect(null)}
    >
      <div className="flex h-full items-center gap-1 px-1">
        {thumbSrc ? (
          <img src={thumbSrc} alt="" draggable={false} className="h-full max-h-6 w-auto shrink-0 rounded object-cover" />
        ) : (
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--surface-hi)] text-[7px] font-semibold uppercase text-[var(--text-faint)]">
            {fileLabel.endsWith(".3mf") ? "3mf" : "gc"}
          </div>
        )}

        {!isCompact && (
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={[
              "truncate text-[9px] font-semibold leading-tight",
              isConflict ? "text-[var(--state-warn)]" : statusTone === "cancelled" ? "text-[var(--state-error)]" : statusTone === "done" ? "text-[var(--state-ok)]" : "text-[var(--text)]",
            ].join(" ")}>
              {isContinuation ? `↩ ${fileLabel}` : fileLabel}
            </span>
            <span className="truncate text-[8px] tabular-nums text-[var(--text-muted)]">
              {timeLabel}{durationLabel ? ` · ${durationLabel}` : ""}
              {entry.runs_total > 1 ? ` · ${entry.runs_completed}/${entry.runs_total}` : ""}
            </span>
          </div>
        )}

        {(onSend || onDelete) && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {(onSend || sendDisabledReason) && status === "queued" && entry.task.gcode_file_id && (
              <button
                type="button"
                disabled={!onSend}
                onClick={e => {
                  e.stopPropagation();
                  onSend?.();
                }}
                className={[
                  "rounded px-1.5 py-0.5 text-[8px] font-bold text-white",
                  onSend ? "bg-[var(--accent)]" : "cursor-not-allowed bg-[var(--state-idle)] opacity-60",
                ].join(" ")}
                title={sendDisabledReason ?? "Надіслати на принтер"}
                aria-label={`Запустити ${fileLabel} на запланованому принтері`}
              >
                ▶
              </button>
            )}
            {!isCompact && onDelete && status === "queued" && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="rounded bg-[var(--state-error)]/15 px-1.5 py-0.5 text-[8px] font-bold text-[var(--state-error)] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                title="Видалити з розкладу"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>
      {popoverRect && <JobPopover block={block} rect={popoverRect} />}
    </div>
  );
}
