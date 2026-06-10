"use client";

import { useState } from "react";
import type { CalendarEntry, CalendarLane } from "@/lib/types";
import type { ScheduleModalMode } from "./ScheduleModal";
import { ScheduleJobBlock } from "./ScheduleJobBlock";
import { ScheduleWeekNav } from "./ScheduleWeekNav";
import { ApiError, createPlanEntry, updatePlanEntry } from "@/lib/api";
import {
  buildCalendarBlocks,
  buildUntimedMap,
  getWeekDates,
  isoDateStr,
} from "./utils";

// ── Zoom config ───────────────────────────────────────────────────────────────

const ZOOM_COL_PX  = [0, 0, 280, 420, 620] as const; // zoom 1 = flex
const ZOOM_ROW_H   = [0, 80, 96, 112, 128] as const;
const ZOOM_STEP    = [0, 6,  3,  2,   1  ] as const; // hours between ticks
type  Zoom = 1 | 2 | 3 | 4;

const UA_DAY = ["Пн","Вт","Ср","Чт","Пт","Сб","Нд"] as const;
const UA_MON = ["січ","лют","бер","кві","тра","чер","лип","сер","вер","жов","лис","гру"] as const;
const ROW_LABEL_W = "152px";

// ── Adaptive hour ruler ───────────────────────────────────────────────────────

function HourRuler({ step }: { step: number }) {
  const hours: number[] = [];
  for (let h = 0; h <= 23; h += step) hours.push(h);

  return (
    <div className="relative h-6 w-full select-none border-t border-[var(--border)]">
      {hours.map(h => (
        <div
          key={h}
          style={{ left: `${(h / 24) * 100}%` }}
          className="absolute top-0 flex flex-col items-center"
        >
          <div className="h-1.5 w-px bg-[var(--border-strong)]" />
          <span className="mt-px -translate-x-1/2 text-[8px] tabular-nums leading-none text-[var(--text-faint)]">
            {String(h).padStart(2, "0")}
          </span>
        </div>
      ))}
      {/* midnight cap */}
      <div className="absolute right-0 top-0 h-1.5 w-px bg-[var(--border-strong)]" />
    </div>
  );
}

/** Vertical grid lines at each hour step. */
function HourGrid({ step }: { step: number }) {
  const hours: number[] = [];
  for (let h = 0; h <= 23; h += step) hours.push(h);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {hours.map(h => (
        <div
          key={h}
          style={{ left: `${(h / 24) * 100}%` }}
          className={[
            "absolute inset-y-0 w-px",
            h % 6 === 0 ? "bg-[var(--border-strong)]" : "bg-[var(--border)]",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

/** Chips for untimed/asap entries stacked at bottom of cell. */
function UntimedChips({
  entries,
  onEntryClick,
}: {
  entries: CalendarEntry[];
  onEntryClick: (e: CalendarEntry) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="absolute bottom-0.5 left-0.5 right-0.5 z-10 flex flex-wrap gap-0.5">
      {entries.map(e => (
        <button
          key={e.id}
          type="button"
          onClick={ev => { ev.stopPropagation(); onEntryClick(e); }}
          draggable
          onDragStart={ev => {
            ev.stopPropagation();
            ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "block", entryId: e.id }));
            ev.dataTransfer.effectAllowed = "move";
          }}
          title={e.task.title}
          className="max-w-[100px] truncate rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1 py-px text-[9px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
        >
          {e.task.file_name ?? e.task.title}
        </button>
      ))}
    </div>
  );
}

function CalendarSkeleton({ rows = 3, zoom }: { rows?: number; zoom: Zoom }) {
  const rowH = ZOOM_ROW_H[zoom];
  return (
    <div className="animate-pulse space-y-px">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex">
          <div
            style={{ width: ROW_LABEL_W, minWidth: ROW_LABEL_W }}
            className="shrink-0 border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
          >
            <div className="h-3 w-24 rounded bg-[var(--surface-hi)]" />
          </div>
          {Array.from({ length: 7 }).map((_, j) => (
            <div
              key={j}
              style={{ height: rowH }}
              className="flex-1 border border-[var(--border)] bg-[var(--bg-elevated)]"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Drop-time indicator overlay ───────────────────────────────────────────────

function DropOverlay({ relX }: { relX: number }) {
  const mins = Math.min(Math.round(relX * 1440 / 15) * 15, 1410);
  const label = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30 flex items-center"
      style={{ left: `${relX * 100}%` }}
    >
      <div className="h-full w-0.5 bg-[var(--accent)]" />
      <span className="ml-1 rounded bg-[var(--accent)] px-1 py-px text-[9px] font-bold text-white">
        {label}
      </span>
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
  onRefresh: () => void;
}

export function ScheduleCalendar({
  lanes,
  weekStart,
  loading,
  onPrevWeek,
  onNextWeek,
  onOpenModal,
  onRefresh,
}: Props) {
  const weekDates = getWeekDates(weekStart);
  const todayStr  = isoDateStr(new Date());

  const [zoom, setZoom] = useState<Zoom>(2);
  const step  = ZOOM_STEP[zoom];
  const rowH  = ZOOM_ROW_H[zoom];
  const colTemplate =
    zoom === 1
      ? `${ROW_LABEL_W} repeat(7, minmax(160px, 1fr))`
      : `${ROW_LABEL_W} repeat(7, ${ZOOM_COL_PX[zoom]}px)`;

  // DnD state
  const [dropCell, setDropCell]       = useState<string | null>(null);  // `${printerId}-${di}`
  const [dropRelX,  setDropRelX]      = useState<number>(0);
  const [dropping, setDropping]       = useState(false);
  const [dropError, setDropError]     = useState<string | null>(null);

  const blockMap   = buildCalendarBlocks(lanes, weekDates);
  const untimedMap = buildUntimedMap(lanes, weekDates);

  function handleEntryClick(entry: CalendarEntry) {
    onOpenModal({ type: "edit", entry });
  }

  // ── drop handler ────────────────────────────────────────────────────────────

  async function handleDrop(
    e: React.DragEvent<HTMLDivElement>,
    printerId: number,
    planDate: string,
  ) {
    e.preventDefault();
    setDropCell(null);

    let data: { type: "block"; entryId: number } | { type: "backlog"; taskId: number };
    try {
      data = JSON.parse(e.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    const startMins = Math.min(Math.round(relX * 1440 / 15) * 15, 1410);
    const hh = String(Math.floor(startMins / 60)).padStart(2, "0");
    const mm = String(startMins % 60).padStart(2, "0");
    const startTime = `${hh}:${mm}:00`;

    setDropping(true);
    try {
      if (data.type === "block") {
        await updatePlanEntry(data.entryId, {
          plan_date: planDate,
          start_time: startTime,
          schedule_mode: "exact_time",
          printer_id: printerId,
        });
      } else {
        await createPlanEntry({
          printer_id: printerId,
          plan_date: planDate,
          task_id: data.taskId,
          start_time: startTime,
          schedule_mode: "exact_time",
        });
      }
      onRefresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Помилка переміщення";
      setDropError(msg);
      setTimeout(() => setDropError(null), 3500);
    } finally {
      setDropping(false);
    }
  }

  return (
    <div className="flex h-full flex-col">

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2">
        <ScheduleWeekNav weekStart={weekStart} onPrev={onPrevWeek} onNext={onNextWeek} />

        <div className="flex items-center gap-4">
          {/* Legend */}
          <div className="hidden items-center gap-3 text-[10px] text-[var(--text-faint)] sm:flex">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm border-t-2 border-t-[var(--accent)] bg-[var(--accent-soft)]" />
              заплановано
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm border-t-2 border-t-[var(--state-warn)] bg-[rgba(217,119,6,.18)]" />
              конфлікт
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm border border-dashed border-[var(--accent)] bg-[var(--accent-soft)]" />
              продовження
            </span>
          </div>

          {/* Zoom */}
          <div className="flex items-center gap-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-1 py-0.5">
            <button
              type="button"
              onClick={() => setZoom(z => Math.max(1, z - 1) as Zoom)}
              disabled={zoom === 1}
              className="flex h-5 w-5 items-center justify-center rounded text-sm font-bold text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] disabled:opacity-30"
            >
              −
            </button>
            <span className="min-w-[20px] text-center text-[10px] font-semibold tabular-nums text-[var(--text-muted)]">
              {zoom}×
            </span>
            <button
              type="button"
              onClick={() => setZoom(z => Math.min(4, z + 1) as Zoom)}
              disabled={zoom === 4}
              className="flex h-5 w-5 items-center justify-center rounded text-sm font-bold text-[var(--text-muted)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] disabled:opacity-30"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Drop error toast */}
      {dropError && (
        <div className="mx-4 mt-2 rounded border border-[rgba(239,68,68,.3)] bg-[rgba(239,68,68,.08)] px-3 py-1.5 text-xs text-[var(--state-error)]">
          {dropError}
        </div>
      )}

      {/* ── Grid ── */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4">
            <CalendarSkeleton rows={Math.max(3, lanes.length)} zoom={zoom} />
          </div>
        ) : (
          <div
            className="min-w-max"
            style={{ display: "grid", gridTemplateColumns: colTemplate }}
          >
            {/* ── Header row ── */}
            <div className="sticky left-0 top-0 z-20 border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                Принтер
              </span>
            </div>

            {weekDates.map((d, di) => {
              const isToday = isoDateStr(d) === todayStr;
              return (
                <div
                  key={di}
                  className={[
                    "sticky top-0 z-20 border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-2 pb-0 pt-1.5",
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
                  <HourRuler step={step} />
                </div>
              );
            })}

            {/* ── Printer rows ── */}
            {lanes.length === 0 ? (
              <div className="sticky left-0 z-10 col-span-8 border-b border-[var(--border)] bg-[var(--bg-elevated)] py-12 text-center text-sm text-[var(--text-faint)]">
                Принтерів не знайдено. Додайте принтери в Налаштуваннях.
              </div>
            ) : (
              lanes.map(lane => (
                <>
                  {/* Label cell */}
                  <div
                    key={`label-${lane.printer_id}`}
                    className="sticky left-0 z-10 flex flex-col justify-center border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
                    style={{ minHeight: rowH }}
                  >
                    <span className="text-xs font-medium text-[var(--text)]">{lane.printer_name}</span>
                    <span className="mt-0.5 text-[10px] text-[var(--text-faint)] capitalize">
                      {lane.printer_kind === "bambu"
                        ? "Bambu"
                        : lane.printer_kind === "snapmaker_u1"
                        ? "Snapmaker"
                        : "Інший"}
                    </span>
                  </div>

                  {/* Day cells */}
                  {weekDates.map((d, di) => {
                    const dateStr  = isoDateStr(d);
                    const isToday  = dateStr === todayStr;
                    const cellKey  = `${lane.printer_id}-${di}`;
                    const blocks   = blockMap.get(cellKey as `${number}-${number}`) ?? [];
                    const untimed  = untimedMap.get(cellKey as `${number}-${number}`) ?? [];
                    const isDropTarget = dropCell === cellKey;

                    return (
                      <div
                        key={`cell-${lane.printer_id}-${di}`}
                        className={[
                          "relative border-b border-r border-[var(--border)] transition-colors",
                          isToday ? "bg-[rgba(34,211,238,.03)]" : "bg-[var(--bg-elevated)]",
                          isDropTarget ? "bg-[rgba(34,211,238,.10)] ring-1 ring-inset ring-[var(--accent)]" : "",
                          dropping ? "cursor-wait" : "",
                        ].join(" ")}
                        style={{ minHeight: rowH }}
                        onDragOver={e => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          const rect = e.currentTarget.getBoundingClientRect();
                          setDropRelX(Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width)));
                          setDropCell(cellKey);
                        }}
                        onDragLeave={e => {
                          // only clear if leaving the cell itself (not a child)
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                            setDropCell(null);
                          }
                        }}
                        onDrop={e => handleDrop(e, lane.printer_id, dateStr)}
                      >
                        <HourGrid step={step} />
                        <UntimedChips entries={untimed} onEntryClick={handleEntryClick} />

                        {blocks.map((block, bi) => (
                          <ScheduleJobBlock
                            key={`${block.entry.id}-${bi}`}
                            block={block}
                            onClick={() => handleEntryClick(block.entry)}
                          />
                        ))}

                        {/* Drop position indicator */}
                        {isDropTarget && <DropOverlay relX={dropRelX} />}
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
