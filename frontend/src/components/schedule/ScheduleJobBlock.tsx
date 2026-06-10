"use client";

import type { CalendarBlock } from "./utils";
import { fmtTimeMins, fmtDuration } from "./utils";

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
  cellWidthPx,
  onClick,
}: {
  block: CalendarBlock;
  cellWidthPx: number;
  onClick: () => void;
}) {
  const { entry, startMins, endMins, isContinuation, totalDurationMins } = block;
  const isConflict = entry.conflict;
  const isBlocked  = !!entry.blocked_reason && entry.schedule_mode !== "asap";

  const leftPct  = (startMins / 1440) * 100;
  const widthPct = ((endMins - startMins) / 1440) * 100;

  // Minimum visible width so short jobs don't disappear
  const minWidthPx = 36;
  const computedWidthPx = (widthPct / 100) * cellWidthPx;
  const tooNarrow = computedWidthPx < minWidthPx;

  const startLabel = fmtTimeMins(startMins);
  const endLabel   = fmtTimeMins(endMins < 1440 ? endMins : 0); // 1440 = 00:00 next day

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

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${entry.task.title}\n${startLabel}–${endLabel} · ${fmtDuration(totalDurationMins)}`}
      style={{ left: `${leftPct}%`, width: `max(${minWidthPx}px, ${widthPct}%)` }}
      className={`${base} ${colorCls} ${topBorder}`}
    >
      <div className="flex h-full flex-col justify-start gap-0.5 px-1.5 pt-1">
        {/* Title line */}
        <span className={[
          "truncate text-[10px] font-semibold leading-tight",
          tooNarrow ? "opacity-0" : "",
          isConflict ? "text-[var(--state-warn)]" : "text-[var(--text)]",
        ].join(" ")}>
          {isContinuation ? `↩ ${entry.task.title}` : entry.task.title}
        </span>

        {/* Time + duration */}
        {!tooNarrow && (
          <span className="truncate text-[9px] tabular-nums text-[var(--text-muted)]">
            {isContinuation
              ? `до ${endLabel}`
              : `${startLabel}–${endMins >= 1440 ? "00:00↗" : endLabel}`}
            {" · "}{fmtDuration(totalDurationMins)}
          </span>
        )}

        {/* Conflict / blocked indicators */}
        {!tooNarrow && isConflict && (
          <span className="text-[9px] text-[var(--state-warn)]">⚠ конфлікт</span>
        )}
        {!tooNarrow && isBlocked && !isConflict && (
          <span className="text-[9px] text-[var(--state-idle)]">⊘ заблоковано</span>
        )}
      </div>
    </button>
  );
}
