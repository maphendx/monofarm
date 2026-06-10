"use client";

import { useRef, useEffect, useState } from "react";
import type { CalendarEntry, CalendarLane, PrintTask } from "@/lib/types";
import type { ScheduleModalMode } from "./ScheduleModal";
import { ScheduleJobBlock } from "./ScheduleJobBlock";
import { ScheduleWeekNav } from "./ScheduleWeekNav";
import {
  buildCalendarBlocks,
  buildUntimedMap,
  getWeekDates,
  isoDateStr,
  fmtTimeMins,
} from "./utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const UA_DAY   = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"] as const;
const UA_MON   = ["січ","лют","бер","кві","тра","чер","лип","сер","вер","жов","лис","гру"] as const;
const HOUR_MARKS = [0, 6, 12, 18] as const; // labels shown on the tick ruler

const CELL_HEIGHT_PX = 88; // height of each printer-row cell
const ROW_LABEL_W    = "160px";

// ── Sub-components ────────────────────────────────────────────────────────────

function HourRuler() {
  return (
    <div className="relative h-5 w-full select-none">
      {HOUR_MARKS.map(h => (
        <span
          key={h}
          style={{ left: `${(h / 24) * 100}%` }}
          className="absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-[var(--text-faint)]"
        >
          {String(h).padStart(2, "0")}:00
        </span>
      ))}
      {/* Tick marks every 6h */}
      {HOUR_MARKS.map(h => (
        <div
          key={h}
          style={{ left: `${(h / 24) * 100}%` }}
          className="absolute bottom-0 h-2 w-px bg-[var(--border-strong)]"
        />
      ))}
    </div>
  );
}

/** Vertical grid lines every 6h inside a day cell. */
function HourGrid() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {HOUR_MARKS.map(h => (
        <div
          key={h}
          style={{ left: `${(h / 24) * 100}%` }}
          className="absolute inset-y-0 w-px bg-[var(--border)]"
        />
      ))}
    </div>
  );
}

/** Small chips for asap/untimed entries at the top of a day cell. */
function UntimedChips({
  entries,
  onEntryClick,
}: {
  entries: CalendarEntry[];
  onEntryClick: (e: CalendarEntry) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="absolute left-1 right-1 top-0.5 z-10 flex flex-wrap gap-0.5">
      {entries.map(e => (
        <button
          key={e.id}
          type="button"
          onClick={() => onEntryClick(e)}
          title={e.task.title}
          className="max-w-[90px] truncate rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1 py-px text-[9px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
        >
          {e.task.file_name ?? e.task.title}
        </button>
      ))}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function CalendarSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-px">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex">
          <div
            style={{ width: ROW_LABEL_W, minWidth: ROW_LABEL_W }}
            className="shrink-0 rounded-l border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <div className="h-3 w-24 rounded bg-[var(--surface-hi)]" />
            <div className="mt-1 h-2 w-16 rounded bg-[var(--surface-hi)]" />
          </div>
          {Array.from({ length: 7 }).map((_, j) => (
            <div
              key={j}
              style={{ height: CELL_HEIGHT_PX }}
              className="flex-1 border border-[var(--border)] bg-[var(--bg-elevated)]"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  lanes: CalendarLane[];
  weekStart: Date;
  loading: boolean;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onOpenModal: (mode: ScheduleModalMode) => void;
}

export function ScheduleCalendar({
  lanes,
  weekStart,
  loading,
  onPrevWeek,
  onNextWeek,
  onOpenModal,
}: Props) {
  const weekDates = getWeekDates(weekStart);
  const todayStr  = isoDateStr(new Date());

  // Measure day-cell width for ScheduleJobBlock min-width logic
  const cellRef   = useRef<HTMLDivElement>(null);
  const [cellW, setCellW] = useState(200);
  useEffect(() => {
    if (!cellRef.current) return;
    const obs = new ResizeObserver(entries => {
      setCellW(entries[0]?.contentRect.width ?? 200);
    });
    obs.observe(cellRef.current);
    return () => obs.disconnect();
  }, []);

  const blockMap   = buildCalendarBlocks(lanes, weekDates);
  const untimedMap = buildUntimedMap(lanes, weekDates);

  function handleEntryClick(entry: CalendarEntry) {
    onOpenModal({ type: "edit", entry });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5">
        <ScheduleWeekNav
          weekStart={weekStart}
          onPrev={onPrevWeek}
          onNext={onNextWeek}
        />
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-faint)]">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm border-t-2 border-t-[var(--accent)] bg-[var(--accent-soft)]" />
            заплановано
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm border-t-2 border-t-[var(--state-warn)] bg-[rgba(217,119,6,.18)]" />
            конфлікт
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-[var(--accent)] bg-[var(--accent-soft)]" />
            продовження
          </span>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4"><CalendarSkeleton rows={Math.max(3, lanes.length)} /></div>
        ) : (
          <div
            className="min-w-max"
            style={{ display: "grid", gridTemplateColumns: `${ROW_LABEL_W} repeat(7, minmax(120px, 1fr))` }}
          >
            {/* ── Header row ── */}
            <div className="sticky left-0 top-0 z-20 border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                Принтер
              </span>
            </div>

            {weekDates.map((d, di) => {
              const dateStr = isoDateStr(d);
              const isToday = dateStr === todayStr;
              return (
                <div
                  key={di}
                  className={[
                    "sticky top-0 z-20 border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5",
                    isToday ? "bg-[var(--accent-soft)]" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className={[
                      "text-[10px] font-semibold",
                      isToday ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
                    ].join(" ")}>
                      {UA_DAY[di]} {d.getDate()} {UA_MON[d.getMonth()]}
                    </span>
                    {isToday && (
                      <span className="rounded-full bg-[var(--accent)] px-1 py-px text-[8px] font-bold text-white">
                        TODAY
                      </span>
                    )}
                  </div>
                  <HourRuler />
                </div>
              );
            })}

            {/* ── Printer rows ── */}
            {lanes.length === 0 ? (
              <>
                <div
                  className="sticky left-0 z-10 col-span-8 border-b border-[var(--border)] bg-[var(--bg-elevated)] py-12 text-center text-sm text-[var(--text-faint)]"
                >
                  Принтерів не знайдено. Додайте принтери в Налаштуваннях.
                </div>
              </>
            ) : (
              lanes.map(lane => (
                <>
                  {/* Printer label cell */}
                  <div
                    key={`label-${lane.printer_id}`}
                    className="sticky left-0 z-10 flex flex-col justify-center border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
                    style={{ minHeight: CELL_HEIGHT_PX }}
                  >
                    <span className="text-xs font-medium text-[var(--text)]">{lane.printer_name}</span>
                    <span className="mt-0.5 text-[10px] text-[var(--text-faint)] capitalize">
                      {lane.printer_kind === "bambu" ? "Bambu" : lane.printer_kind === "snapmaker_u1" ? "Snapmaker" : "Інший"}
                    </span>
                  </div>

                  {/* Day cells */}
                  {weekDates.map((d, di) => {
                    const dateStr = isoDateStr(d);
                    const isToday = dateStr === todayStr;
                    const key = `${lane.printer_id}-${di}` as `${number}-${number}`;
                    const blocks   = blockMap.get(key)   ?? [];
                    const untimed  = untimedMap.get(key) ?? [];

                    return (
                      <div
                        key={`cell-${lane.printer_id}-${di}`}
                        ref={di === 0 ? cellRef : undefined}
                        className={[
                          "relative border-b border-r border-[var(--border)]",
                          isToday ? "bg-[rgba(34,211,238,.04)]" : "bg-[var(--bg-elevated)]",
                        ].join(" ")}
                        style={{ minHeight: CELL_HEIGHT_PX }}
                      >
                        <HourGrid />
                        <UntimedChips entries={untimed} onEntryClick={handleEntryClick} />

                        {blocks.map((block, bi) => (
                          <ScheduleJobBlock
                            key={`${block.entry.id}-${bi}`}
                            block={block}
                            cellWidthPx={cellW}
                            onClick={() => handleEntryClick(block.entry)}
                          />
                        ))}

                        {/* Empty cell hint — no blocks and no untimed */}
                        {blocks.length === 0 && untimed.length === 0 && (
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                            <span className="text-[9px] text-[var(--text-faint)]">порожньо</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
