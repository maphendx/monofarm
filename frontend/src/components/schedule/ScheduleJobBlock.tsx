"use client";

import type { CalendarBlock } from "./utils";
import { fmtTimeMins, fmtDuration } from "./utils";
import { API_URL } from "@/lib/api";

/**
 * A single timed block on the calendar timeline.
 *
 * Position is controlled by the parent cell via absolute CSS:
 *   left: (startMins / 1440) * 100%
 *   width: ((endMins - startMins) / 1440) * 100%
 *
 * Continuation blocks (overflow from previous day) use a dashed left border
 * and a "↩ continued" label instead of the job title.
 */
export function ScheduleJobBlock({
  block,
  onClick,
}: {
  block: CalendarBlock;
  onClick: () => void;
}) {
  const { entry, startMins, endMins, isContinuation, totalDurationMins } = block;
  const isConflict = entry.conflict;
  const isBlocked  = !!entry.blocked_reason && entry.schedule_mode !== "asap";

  const leftPct   = (startMins / 1440) * 100;
  const widthPct  = ((endMins - startMins) / 1440) * 100;
  const minWidthPx = 36;

  const isCompact = widthPct < 8;

  const startLabel = fmtTimeMins(startMins);
  const endLabel   = fmtTimeMins(endMins < 1440 ? endMins : 0); // 1440 = 00:00 next day
  const timeLabel  = isContinuation
    ? `до ${endLabel}`
    : endMins > startMins
    ? `${startLabel}–${endMins >= 1440 ? "00:00↗" : endLabel}`
    : startLabel;
  const durationLabel = fmtDuration(totalDurationMins);
  const fileLabel  = entry.task.file_name ?? entry.task.title;
  const taskLabel  = entry.task.title !== fileLabel ? entry.task.title : null;
  const thumbSrc   = entry.task.has_thumbnail && entry.task.gcode_file_id
    ? `${API_URL}/api/files/${entry.task.gcode_file_id}/thumbnail`
    : null;

  const base =
    "absolute top-1 bottom-1 rounded overflow-hidden cursor-pointer select-none transition-opacity hover:opacity-90 active:opacity-75";

  const colorCls = isConflict
    ? "bg-[rgba(217,119,6,.18)] border border-[rgba(217,119,6,.45)]"
    : isBlocked
    ? "bg-[rgba(113,113,122,.14)] border border-[rgba(113,113,122,.35)]"
    : isContinuation
    ? "bg-[var(--accent-soft)] border border-dashed border-[var(--accent)]"
    : "bg-[var(--accent-soft)] border border-[var(--accent)]";

  const topBorder = !isContinuation
    ? isConflict
      ? "border-t-[3px] border-t-[var(--state-warn)]"
      : isBlocked
      ? "border-t-[3px] border-t-[var(--state-idle)]"
      : "border-t-[3px] border-t-[var(--accent)]"
    : "";

  function onDragStart(e: React.DragEvent<HTMLButtonElement>) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "block", entryId: entry.id }));
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={`${fileLabel}${taskLabel ? `\n${taskLabel}` : ""}\n${timeLabel}${durationLabel ? ` · ${durationLabel}` : ""}`}
      style={{ left: `${leftPct}%`, width: `max(${minWidthPx}px, ${widthPct}%)` }}
      className={`${base} ${colorCls} ${topBorder}`}
    >
      <div className="flex h-full items-start gap-1.5 px-1.5 pt-1">
        {isCompact ? (
          <div className="flex h-full w-full items-center justify-center px-0.5 py-1">
            <span className={[
              "max-h-full overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-semibold leading-none [text-orientation:mixed] [writing-mode:vertical-rl]",
              isConflict ? "text-[var(--state-warn)]" : "text-[var(--text)]",
            ].join(" ")}>
              {isContinuation ? `↩ ${fileLabel}` : fileLabel}
            </span>
          </div>
        ) : (
          <>
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt=""
                draggable={false}
                className="h-8 w-8 shrink-0 rounded object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--surface-hi)] text-[8px] font-semibold uppercase text-[var(--text-faint)]">
                3mf
              </div>
            )}
          </>
        )}

        {!isCompact && <div className="flex min-w-0 flex-1 flex-col justify-start gap-0.5">
          {/* File name line */}
          <span className={[
            "truncate text-[10px] font-semibold leading-tight",
            isConflict ? "text-[var(--state-warn)]" : "text-[var(--text)]",
          ].join(" ")}>
            {isContinuation ? `↩ ${fileLabel}` : fileLabel}
          </span>

          {!isCompact && taskLabel && (
            <span className="truncate text-[9px] leading-tight text-[var(--text-faint)]">
              {taskLabel}
            </span>
          )}

          {/* Time + duration */}
          <span className="truncate text-[9px] tabular-nums text-[var(--text-muted)]">
            {timeLabel}{durationLabel ? ` · ${durationLabel}` : ""}
          </span>

          {/* Conflict / blocked indicators */}
          {!isCompact && isConflict && (
            <span className="text-[9px] text-[var(--state-warn)]">⚠ конфлікт</span>
          )}
          {!isCompact && isBlocked && !isConflict && (
            <span className="text-[9px] text-[var(--state-idle)]">⊘ заблоковано</span>
          )}
        </div>}
      </div>
    </button>
  );
}
