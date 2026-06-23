"use client";

import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { getWeekDates, isoDateStr } from "./utils";

const UA_DAY = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"] as const;
const UA_MON = ["січ","лют","бер","кві","тра","чер","лип","сер","вер","жов","лис","гру"] as const;

export function ScheduleWeekNav({
  weekStart,
  onPrev,
  onNext,
  onPrevDay,
  onNextDay,
  onToday,
  onDateChange,
  onDayClick,
}: {
  weekStart: Date;
  onPrev: () => void;
  onNext: () => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  onDateChange: (date: Date) => void;
  onDayClick?: (dayIndex: number) => void;
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
    <div className="flex min-w-0 items-center gap-2">
      <button
        onClick={onPrev}
        aria-label="Попередні 7 днів"
        title="Попередні 7 днів"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        <ChevronsLeft size={14} />
      </button>

      <button
        onClick={onPrevDay}
        aria-label="Попередній день"
        title="Попередній день"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        <ChevronLeft size={14} />
      </button>

      <div className="flex items-center gap-1">
        <span className="min-w-[168px] text-center text-sm font-semibold">{rangeLabel}</span>
      </div>

      <button
        onClick={onNextDay}
        aria-label="Наступний день"
        title="Наступний день"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        <ChevronRight size={14} />
      </button>

      <button
        onClick={onNext}
        aria-label="Наступні 7 днів"
        title="Наступні 7 днів"
        className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hi)]"
      >
        <ChevronsRight size={14} />
      </button>

      <button
        type="button"
        onClick={onToday}
        className="hidden h-7 items-center gap-1.5 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] sm:flex"
      >
        <CalendarDays size={13} />
        Сьогодні
      </button>

      <input
        type="date"
        value={isoDateStr(first)}
        onChange={e => {
          if (!e.target.value) return;
          const [y, m, d] = e.target.value.split("-").map(Number);
          if (!y || !m || !d) return;
          onDateChange(new Date(y, m - 1, d));
        }}
        aria-label="Перейти до дати"
        className="hidden h-7 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-xs text-[var(--text-muted)] outline-none focus:border-[var(--accent)] xl:block"
      />

      {/* Day pills — clickable to scroll to that day column */}
      <div className="ml-2 hidden items-center gap-1 lg:flex">
        {dates.map((d, i) => {
          const isToday = isoDateStr(d) === today;
          const dayLabel = UA_DAY[(d.getDay() + 6) % 7];
          return (
            <button
              key={i}
              type="button"
              onClick={() => onDayClick?.(i)}
              className={[
                "rounded px-2 py-0.5 text-xs tabular-nums transition-colors",
                isToday
                  ? "bg-[var(--accent)] font-semibold text-white hover:bg-[var(--accent-hi)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {dayLabel} {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
