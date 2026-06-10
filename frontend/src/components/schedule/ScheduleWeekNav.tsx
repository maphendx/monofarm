"use client";

import { getWeekDates, isoDateStr } from "./utils";

const UA_DAY = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"] as const;
const UA_MON = ["січ","лют","бер","кві","тра","чер","лип","сер","вер","жов","лис","гру"] as const;

export function ScheduleWeekNav({
  weekStart,
  onPrev,
  onNext,
}: {
  weekStart: Date;
  onPrev: () => void;
  onNext: () => void;
}) {
  const dates  = getWeekDates(weekStart);
  const today  = isoDateStr(new Date());
  const first  = dates[0];
  const last   = dates[6];

  const rangeLabel =
    first.getMonth() === last.getMonth()
      ? `${first.getDate()}–${last.getDate()} ${UA_MON[first.getMonth()]} ${first.getFullYear()}`
      : `${first.getDate()} ${UA_MON[first.getMonth()]} – ${last.getDate()} ${UA_MON[last.getMonth()]} ${first.getFullYear()}`;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onPrev}
        aria-label="Попередній тиждень"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        ‹
      </button>

      <div className="flex items-center gap-1">
        <span className="min-w-[168px] text-center text-sm font-semibold">{rangeLabel}</span>
      </div>

      <button
        onClick={onNext}
        aria-label="Наступний тиждень"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        ›
      </button>

      {/* Day pills — shown on wide screens */}
      <div className="ml-4 hidden items-center gap-1 lg:flex">
        {dates.map((d, i) => {
          const isToday = isoDateStr(d) === today;
          return (
            <span
              key={i}
              className={[
                "rounded px-2 py-0.5 text-xs tabular-nums",
                isToday
                  ? "bg-[var(--accent)] font-semibold text-white"
                  : "text-[var(--text-muted)]",
              ].join(" ")}
            >
              {UA_DAY[i]} {d.getDate()}
            </span>
          );
        })}
      </div>
    </div>
  );
}
