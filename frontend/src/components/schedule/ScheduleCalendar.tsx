"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEntry, CalendarLane, Printer } from "@/lib/types";
import { stateLabel } from "@/lib/printerLabels";
import type { ScheduleModalMode } from "./ScheduleModal";
import { ScheduleJobBlock } from "./ScheduleJobBlock";
import { ScheduleWeekNav } from "./ScheduleWeekNav";
import { ApiError, createPlanEntry, updatePlanEntry } from "@/lib/api";
import {
  buildCalendarBlocks,
  buildUntimedMap,
  fmtDuration,
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
type StateFilter = "all" | "attention" | "printing" | "idle" | "paused" | "offline";

const ATTENTION_STATES = new Set(["error", "paused", "offline", "not_connected", "awaiting_bed_clear", "in_maintenance"]);

function weekdayLabel(d: Date): string {
  return UA_DAY[(d.getDay() + 6) % 7];
}

function minutesSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - start.getTime()) / 60000));
}

function printerMatchesFilter(printer: Printer | undefined, filter: StateFilter): boolean {
  if (filter === "all") return true;
  if (!printer) return false;
  const state = printer.state ?? "unknown";
  const flags = printer.flags ?? [];
  if (filter === "attention") {
    return ATTENTION_STATES.has(state) || flags.includes("requires_attention") || flags.includes("ai_detected_high") || flags.includes("ai_detected_low");
  }
  if (filter === "printing") return state === "printing";
  if (filter === "paused") return state === "paused";
  if (filter === "offline") return state === "offline" || state === "not_connected";
  return state === "idle" || state === "operational" || state === "online" || state === "print_pending";
}

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

function DropOverlay({ relX, incompat }: { relX: number; incompat?: boolean }) {
  const mins = Math.min(Math.round(relX * 1440 / 15) * 15, 1410);
  const label = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  const color = incompat ? "var(--state-error)" : "var(--accent)";
  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30 flex items-center"
      style={{ left: `${relX * 100}%` }}
    >
      <div className="h-full w-0.5" style={{ background: color }} />
      <span className="ml-1 rounded px-1 py-px text-[9px] font-bold text-white" style={{ background: color }}>
        {incompat ? "✕" : label}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/** Running print bar — shows active job directly on the calendar grid. */
function RunningPrintBar({ printer, nowMins }: { printer: Printer; nowMins: number }) {
  if (printer.state !== "printing" || !printer.eta_minutes) return null;
  const remainMins = printer.eta_minutes;
  if (remainMins <= 0) return null;
  const progressPct = Math.max(0, Math.min(100, printer.progress_pct ?? 0));
  const endMins = nowMins + remainMins;
  const leftPct = (nowMins / 1440) * 100;
  const widthPct = Math.max(0.6, Math.min((remainMins / 1440) * 100, 100 - leftPct));
  const endLabel = `${String(Math.floor((endMins % 1440) / 60)).padStart(2, "0")}:${String(endMins % 60).padStart(2, "0")}`;
  return (
    <div
      className="absolute top-0.5 z-[5] flex h-[calc(100%-4px)] items-center overflow-hidden rounded-sm border border-[var(--state-print)]/40"
      style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: "rgba(59,130,246,.08)" }}
      title={`${printer.job ?? "друк"} — зараз → ${endLabel}, залишилось ${remainMins}хв`}
    >
      <div
        className="absolute inset-y-0 left-0 bg-[var(--state-print)]/15"
        style={{ width: `${progressPct}%` }}
      />
      <span className="relative z-10 truncate px-1 text-[8px] font-medium text-[var(--state-print)]">
        {printer.job ?? "друк"} · до {endLabel} · {remainMins}хв
      </span>
    </div>
  );
}

function LiveStateBlock({ printer, now, nowMins }: { printer: Printer; now: Date; nowMins: number }) {
  const state = printer.state ?? "unknown";
  if (state === "printing") return null;

  const relevant = state === "error" || state === "paused" || state === "offline" || state === "not_connected" || state === "idle";
  if (!relevant) return null;

  const since = minutesSince(printer.updated_at, now);
  const startMins = since == null ? Math.max(0, nowMins - 30) : Math.max(0, nowMins - since);
  const leftPct = (startMins / 1440) * 100;
  const widthPct = Math.max(1.2, ((nowMins - startMins) / 1440) * 100);
  const isBad = state === "error" || state === "offline" || state === "not_connected";
  const color = isBad ? "var(--state-error)" : state === "paused" ? "var(--state-warn)" : "var(--state-idle)";
  const bg = isBad ? "rgba(239,68,68,.10)" : state === "paused" ? "rgba(245,158,11,.10)" : "rgba(113,113,122,.09)";
  const label = state === "idle" ? "простій" : stateLabel(state);
  const duration = since == null ? "" : ` · ${fmtDuration(since)}`;

  return (
    <div
      className="absolute bottom-1 z-[6] flex h-5 items-center overflow-hidden rounded-sm border px-1"
      style={{ left: `${leftPct}%`, width: `max(42px, ${widthPct}%)`, borderColor: color, background: bg, color }}
      title={`${printer.name}: ${label}${duration}`}
    >
      <span className="truncate text-[8px] font-semibold leading-none">
        {label}{duration}
      </span>
    </div>
  );
}

function FarmStatusPanel({
  printers,
  lanes,
  entries,
  filter,
  onFilterChange,
}: {
  printers: Printer[];
  lanes: CalendarLane[];
  entries: CalendarEntry[];
  filter: StateFilter;
  onFilterChange: (filter: StateFilter) => void;
}) {
  const total = lanes.length;
  const active = printers.filter(p => p.is_active);
  const printing = active.filter(p => p.state === "printing").length;
  const paused = active.filter(p => p.state === "paused").length;
  const attention = active.filter(p => printerMatchesFilter(p, "attention")).length;
  const offline = active.filter(p => printerMatchesFilter(p, "offline")).length;
  const idle = active.filter(p => printerMatchesFilter(p, "idle")).length;
  const eta = active.reduce((sum, p) => sum + (p.state === "printing" ? (p.eta_minutes ?? 0) : 0), 0);
  const done = entries.filter(e => e.task.status === "done").length;
  const cancelled = entries.filter(e => e.task.status === "cancelled").length;
  const plannedMinutes = entries.reduce((sum, e) => sum + (e.task.estimated_minutes ?? e.task.filament_meta?.estimated_minutes ?? 0), 0);

  const chips: { id: StateFilter; label: string; count: number; dot: string }[] = [
    { id: "all", label: "Усі", count: total, dot: "bg-[var(--text-faint)]" },
    { id: "attention", label: "Увага", count: attention, dot: "bg-[var(--state-error)]" },
    { id: "printing", label: "Друк", count: printing, dot: "bg-[var(--state-print)]" },
    { id: "idle", label: "Вільні", count: idle, dot: "bg-[var(--state-idle)]" },
    { id: "paused", label: "Пауза", count: paused, dot: "bg-[var(--state-warn)]" },
    { id: "offline", label: "Офлайн", count: offline, dot: "bg-[var(--state-offline)]" },
  ];

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold text-[var(--text)]">Стан ферми</span>
          <span className="text-[var(--text-muted)]">{printing}/{total} друкують</span>
          {eta > 0 && <span className="text-[var(--text-muted)]">ETA {fmtDuration(eta)}</span>}
          <span className={attention > 0 ? "font-semibold text-[var(--state-error)]" : "text-[var(--text-muted)]"}>
            {attention} потребують уваги
          </span>
          {plannedMinutes > 0 && <span className="text-[var(--text-muted)]">план {fmtDuration(plannedMinutes)}</span>}
          {(done > 0 || cancelled > 0) && (
            <span className="text-[var(--text-muted)]">
              <span className="text-[var(--state-ok)]">{done} заверш.</span>
              {cancelled > 0 && <span className="ml-2 text-[var(--state-error)]">{cancelled} скас.</span>}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {chips.map(chip => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onFilterChange(chip.id)}
              className={[
                "inline-flex h-6 items-center gap-1.5 rounded border px-2 text-[10px] font-medium transition-colors",
                filter === chip.id
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${chip.dot}`} />
              {chip.label}
              <span className="tabular-nums">{chip.count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Props {
  lanes: CalendarLane[];
  weekStart: Date;
  loading: boolean;
  livePrinters?: Printer[];
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  onDateChange: (date: Date) => void;
  onOpenModal: (mode: ScheduleModalMode) => void;
  onRefresh: () => void;
}

export function ScheduleCalendar({
  lanes,
  weekStart,
  loading,
  livePrinters,
  onPrevWeek,
  onNextWeek,
  onPrevDay,
  onNextDay,
  onToday,
  onDateChange,
  onOpenModal,
  onRefresh,
}: Props) {
  const printerById = useMemo(() => {
    const map = new Map<number, Printer>();
    for (const p of (livePrinters ?? [])) map.set(p.id, p);
    return map;
  }, [livePrinters]);
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const todayStr  = isoDateStr(new Date());

  const [zoom, setZoom] = useState<Zoom>(2);
  const step  = ZOOM_STEP[zoom];
  const rowH  = ZOOM_ROW_H[zoom];
  const colTemplate =
    zoom === 1
      ? `${ROW_LABEL_W} repeat(7, minmax(160px, 1fr))`
      : `${ROW_LABEL_W} repeat(7, ${ZOOM_COL_PX[zoom]}px)`;

  // Refs
  const gridRef = useRef<HTMLDivElement>(null);

  // Current time
  const [now, setNow] = useState(() => new Date());
  const nowMins = now.getHours() * 60 + now.getMinutes();
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Auto-follow toggle
  const [autoFollow, setAutoFollow] = useState(false);

  // Auto-scroll effect
  useEffect(() => {
    if (!autoFollow) return;
    const el = gridRef.current;
    if (!el) return;

    const todayIdx = weekDates.findIndex(d => isoDateStr(d) === todayStr);
    if (todayIdx === -1) return; // not showing current week

    let colW: number;
    if (zoom === 1) {
      const headerEl = el.querySelector<HTMLElement>(`[data-day-col="${todayIdx}"]`);
      if (!headerEl) return;
      const targetX = headerEl.offsetLeft + (headerEl.offsetWidth * (nowMins / 1440));
      el.scrollTo({ left: targetX - el.clientWidth / 2, behavior: "smooth" });
      return;
    } else {
      colW = ZOOM_COL_PX[zoom];
    }
    const targetX = 152 + todayIdx * colW + colW * (nowMins / 1440);
    el.scrollTo({ left: targetX - el.clientWidth / 2, behavior: "smooth" });
  }, [autoFollow, nowMins, zoom, weekDates, todayStr]);

  // DnD state
  const [dropCell, setDropCell]       = useState<string | null>(null);  // `${printerId}-${di}`
  const [dropRelX,  setDropRelX]      = useState<number>(0);
  const [dropping, setDropping]       = useState(false);
  const [dropError, setDropError]     = useState<string | null>(null);
  const [dropIncompat, setDropIncompat] = useState(false);

  // Scroll to a specific day column
  const scrollToDay = useCallback((dayIndex: number) => {
    const el = gridRef.current;
    if (!el) return;
    // The printer label column (152px) is sticky, so we just need to scroll
    // to position the target day column right after it.
    let colW: number;
    if (zoom === 1) {
      // flex mode — measure from the DOM
      const headerEl = el.querySelector<HTMLElement>(`[data-day-col="${dayIndex}"]`);
      if (headerEl) {
        // scrollLeft = offsetLeft of the header minus the sticky label width
        el.scrollTo({ left: headerEl.offsetLeft - 152, behavior: "smooth" });
        return;
      }
      colW = 200; // fallback
    } else {
      colW = ZOOM_COL_PX[zoom];
    }
    el.scrollTo({ left: dayIndex * colW, behavior: "smooth" });
  }, [zoom]);

  const blockMap   = useMemo(() => buildCalendarBlocks(lanes, weekDates), [lanes, weekDates]);
  const untimedMap = useMemo(() => buildUntimedMap(lanes, weekDates), [lanes, weekDates]);
  const allEntries = useMemo(
    () => lanes.flatMap(lane => lane.days.flatMap(day => day.entries)),
    [lanes],
  );
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  // Group lanes by group_id, preserving server sort order
  const grouped = useMemo(() => {
    const groups: { groupId: number | null; groupName: string | null; groupColor: string | null; lanes: CalendarLane[] }[] = [];
    const seen = new Map<number | null, typeof groups[0]>();
    for (const lane of lanes) {
      if (!printerMatchesFilter(printerById.get(lane.printer_id), stateFilter)) continue;
      const key = lane.group_id ?? null;
      if (!seen.has(key)) {
        const g = { groupId: key, groupName: lane.group_name ?? null, groupColor: lane.group_color ?? null, lanes: [] as CalendarLane[] };
        groups.push(g);
        seen.set(key, g);
      }
      seen.get(key)!.lanes.push(lane);
    }
    return groups;
  }, [lanes, printerById, stateFilter]);

  function handleEntryClick(entry: CalendarEntry) {
    onOpenModal({ type: "edit", entry });
  }

  function findEntry(entryId: number): CalendarEntry | null {
    for (const lane of lanes) {
      for (const day of lane.days) {
        const entry = day.entries.find(e => e.id === entryId);
        if (entry) return entry;
      }
    }
    return null;
  }

  function getDropMins(e: React.DragEvent<HTMLDivElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
    return Math.min(Math.round(relX * 1440 / 15) * 15, 1410);
  }

  function minsToStartTime(mins: number): string {
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    return `${hh}:${mm}:00`;
  }

  // ── drop handler ────────────────────────────────────────────────────────────

  async function handleDrop(
    e: React.DragEvent<HTMLDivElement>,
    printerId: number,
    planDate: string,
  ) {
    e.preventDefault();
    setDropCell(null);
    setDropIncompat(false);

    let data: { type: "block"; entryId: number } | { type: "backlog"; taskId: number; fileName?: string; quantity?: number; durationMins?: number };
    try {
      data = JSON.parse(e.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }

    const startMins = getDropMins(e);
    const startTime = minsToStartTime(startMins);

    // --- Validation ---
    const fileName = data.type === "block" 
       ? (findEntry(data.entryId)?.task.file_name || "") 
       : (data.fileName || "");
       
    if (fileName) {
       const is3mf = fileName.toLowerCase().endsWith(".3mf");
       const isGcode = fileName.toLowerCase().match(/\.(gcode|gco|g|bgcode)$/);
       const lane = lanes.find(l => l.printer_id === printerId);
       
       if (lane) {
         if (is3mf && lane.printer_kind !== "bambu") {
           setDropError("Файли .3mf можна призначати тільки на принтери Bambu");
           setTimeout(() => setDropError(null), 3500);
           return;
         }
         if (isGcode && lane.printer_kind === "bambu") {
           setDropError("Файли .gcode не можна призначати на принтери Bambu");
           setTimeout(() => setDropError(null), 3500);
           return;
         }
       }
    }

    setDropping(true);
    try {
      if (data.type === "block") {
        const current = findEntry(data.entryId);
        if (
          current &&
          current.printer_id === printerId &&
          current.plan_date === planDate &&
          current.start_time === startTime &&
          current.schedule_mode === "exact_time"
        ) {
          return;
        }
        await updatePlanEntry(data.entryId, {
          plan_date: planDate,
          start_time: startTime,
          schedule_mode: "exact_time",
          printer_id: printerId,
        });
      } else {
        const qty = data.quantity || 1;
        const dur = data.durationMins || 60;
        
        let currMins = startMins;
        const [y, m, d] = planDate.split("-").map(Number);
        const currDate = new Date(y, (m || 1) - 1, d || 1);
        
        for (let i = 0; i < qty; i++) {
          const t = minsToStartTime(currMins % 1440);
          const pDateStr = isoDateStr(currDate);
          
          await createPlanEntry({
            printer_id: printerId,
            plan_date: pDateStr,
            task_id: data.taskId,
            start_time: t,
            schedule_mode: "exact_time",
          });
          
          currMins += dur;
          while (currMins >= 1440) {
            currMins -= 1440;
            currDate.setDate(currDate.getDate() + 1);
          }
        }
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
        <ScheduleWeekNav
          weekStart={weekStart}
          onPrev={onPrevWeek}
          onNext={onNextWeek}
          onPrevDay={onPrevDay}
          onNextDay={onNextDay}
          onToday={onToday}
          onDateChange={onDateChange}
          onDayClick={scrollToDay}
        />

        <div className="flex items-center gap-4">
          {/* Legend */}
          <div className="hidden items-center gap-3 text-[10px] text-[var(--text-faint)] sm:flex">
            <label className="flex items-center gap-1.5 cursor-pointer hover:text-[var(--text)] transition-colors">
              <input
                type="checkbox"
                className="hidden"
                checked={autoFollow}
                onChange={e => setAutoFollow(e.target.checked)}
              />
              <div className={`flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${autoFollow ? 'bg-[var(--accent)]' : 'bg-[var(--surface-hi)] border border-[var(--border-strong)]'}`}>
                <div className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${autoFollow ? 'translate-x-3' : 'translate-x-0'}`} />
              </div>
              <span className={autoFollow ? "text-[var(--text)]" : ""}>слідкувати</span>
            </label>
            <span className="h-3 w-px bg-[var(--border-strong)]" />
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm border-t-2 border-t-[var(--accent)] bg-[var(--accent-soft)]" />
              заплановано
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm border-t-2 border-t-[var(--state-warn)] bg-[rgba(217,119,6,.18)]" />
              конфлікт
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

      <FarmStatusPanel
        printers={livePrinters ?? []}
        lanes={lanes}
        entries={allEntries}
        filter={stateFilter}
        onFilterChange={setStateFilter}
      />

      {/* ── Grid ── */}
      <div ref={gridRef} className="cal-scroll-grid flex-1">
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
                  data-day-col={di}
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
                      {weekdayLabel(d)} {d.getDate()} {UA_MON[d.getMonth()]}
                    </span>
                    {isToday && (
                      <span className="rounded-full bg-[var(--accent)] px-1 py-px text-[8px] font-bold text-white">
                        TODAY
                      </span>
                    )}
                  </div>
                  <HourRuler step={step} />
                  
                  {/* Current time header indicator */}
                  {isToday && (
                    <div
                      className="pointer-events-none absolute bottom-0 top-1.5 z-30 w-[1.5px] bg-[var(--state-error)]"
                      style={{ left: `${(nowMins / 1440) * 100}%` }}
                    >
                      <div className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--state-error)] shadow-sm" />
                    </div>
                  )}
                </div>
              );
            })}

            {/* ── Printer rows ── */}
            {lanes.length === 0 ? (
              <div className="sticky left-0 z-10 col-span-8 border-b border-[var(--border)] bg-[var(--bg-elevated)] py-12 text-center text-sm text-[var(--text-faint)]">
                Принтерів не знайдено. Додайте принтери в Налаштуваннях.
              </div>
            ) : grouped.length === 0 ? (
              <div className="sticky left-0 z-10 col-span-8 border-b border-[var(--border)] bg-[var(--bg-elevated)] py-12 text-center text-sm text-[var(--text-faint)]">
                У цьому фільтрі немає принтерів.
              </div>
            ) : (
              grouped.map(({ groupId, groupName, groupColor, lanes: groupLanes }) => (
                <Fragment key={groupId ?? "__ungrouped"}>
                  {/* Group header row */}
                  {groupName && (
                    <div
                      className="sticky left-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-hi)] px-3 py-1.5"
                      style={{
                        gridColumn: "1 / -1",
                        borderLeft: groupColor ? `3px solid ${groupColor}` : undefined,
                      }}
                    >
                      {groupColor && (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: groupColor }}
                        />
                      )}
                      <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                        {groupName}
                      </span>
                      <span className="text-[10px] text-[var(--text-faint)]">
                        {groupLanes.length} принт.
                      </span>
                      {(() => {
                        const groupPrinters = groupLanes.map(l => printerById.get(l.printer_id)).filter((p): p is Printer => !!p);
                        const printing = groupPrinters.filter(p => p.state === "printing").length;
                        const attention = groupPrinters.filter(p => printerMatchesFilter(p, "attention")).length;
                        const idle = groupPrinters.filter(p => printerMatchesFilter(p, "idle")).length;
                        return (
                          <span className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-faint)]">
                            {printing > 0 && <span className="text-[var(--state-print)]">{printing} друк</span>}
                            {idle > 0 && <span>{idle} вільн.</span>}
                            {attention > 0 && <span className="font-semibold text-[var(--state-error)]">{attention} увага</span>}
                          </span>
                        );
                      })()}
                    </div>
                  )}
                  {groupLanes.map(lane => (
                <Fragment key={lane.printer_id}>
                  {/* Label cell */}
                  <div
                    className="sticky left-0 z-10 flex flex-col justify-center border-b border-r border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2"
                    style={{
                      minHeight: rowH,
                      borderLeft: groupColor ? `3px solid ${groupColor}` : undefined,
                    }}
                  >
                    <span className="text-xs font-medium text-[var(--text)]">{lane.printer_name}</span>
                    {(() => {
                      const lp = printerById.get(lane.printer_id);
                      if (!lp) return (
                        <span className="mt-0.5 text-[10px] text-[var(--text-faint)] capitalize">
                          {lane.printer_kind === "bambu" ? "Bambu" : lane.printer_kind === "snapmaker_u1" ? "Snapmaker" : "Інший"}
                        </span>
                      );
                      const stateColors: Record<string, string> = {
                        printing: "text-[var(--state-print)]",
                        idle: "text-[var(--state-ok)]",
                        paused: "text-[var(--state-warn)]",
                        error: "text-[var(--state-error)]",
                        offline: "text-[var(--state-offline)]",
                        operational: "text-[var(--state-idle)]",
                      };
                      const cls = (lp.state && stateColors[lp.state]) ?? "text-[var(--text-faint)]";
                      const flags = lp.flags ?? [];
                      const needsAttention = flags.includes("requires_attention") || flags.includes("ai_detected_high") || lp.state === "error";
                      const secondary = lp.state === "printing"
                        ? `друкує · ${lp.eta_minutes ?? 0}хв${lp.progress_pct != null ? ` · ${Math.round(lp.progress_pct)}%` : ""}`
                        : stateLabel(lp.state);
                      return (
                        <>
                          <span className={`mt-0.5 text-[10px] ${cls}`}>
                            {secondary}
                          </span>
                          {needsAttention && (
                            <span className="mt-0.5 truncate text-[9px] font-medium text-[var(--state-error)]" title={lp.error_msg ?? "Потребує уваги"}>
                              {lp.error_msg ?? "потребує уваги"}
                            </span>
                          )}
                        </>
                      );
                    })()}
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
                          "relative overflow-visible border-b border-r border-[var(--border)] transition-colors",
                          isToday ? "bg-[rgba(34,211,238,.03)]" : "bg-[var(--bg-elevated)]",
                          isDropTarget && !dropIncompat ? "bg-[rgba(34,211,238,.10)] ring-1 ring-inset ring-[var(--accent)]" : "",
                          isDropTarget && dropIncompat ? "bg-[rgba(239,68,68,.08)] ring-1 ring-inset ring-[var(--state-error)]" : "",
                          dropping ? "cursor-wait" : "",
                        ].join(" ")}
                        style={{ minHeight: rowH }}
                        onDragOver={e => {
                          e.preventDefault();
                          const startMins = getDropMins(e);

                          // Check compatibility from dragged data
                          const incompat = false;
                          try {
                            const raw = e.dataTransfer.types.includes("text/plain") ? "" : "";
                            // File type check based on lane kind
                            const kind = lane.printer_kind;
                            // We can't read dataTransfer during dragOver (security),
                            // so we rely on the existing drop-time check
                            void raw; void kind;
                          } catch { /* ignore */ }

                          setDropIncompat(incompat);
                          e.dataTransfer.dropEffect = incompat ? "none" : "move";
                          setDropRelX(startMins / 1440);
                          setDropCell(cellKey);
                        }}
                        onDragLeave={e => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                            setDropCell(null);
                            setDropIncompat(false);
                          }
                        }}
                        onDrop={e => handleDrop(e, lane.printer_id, dateStr)}
                      >
                        <HourGrid step={step} />

                        {/* Running print bar (today only) */}
                        {isToday && printerById.get(lane.printer_id) && (
                          <RunningPrintBar printer={printerById.get(lane.printer_id)!} nowMins={nowMins} />
                        )}

                        {isToday && printerById.get(lane.printer_id) && (
                          <LiveStateBlock printer={printerById.get(lane.printer_id)!} now={now} nowMins={nowMins} />
                        )}

                        <UntimedChips entries={untimed} onEntryClick={handleEntryClick} />

                        {blocks.map((block, bi) => (
                          <ScheduleJobBlock
                            key={`${block.entry.id}-${bi}`}
                            block={block}
                            onClick={() => handleEntryClick(block.entry)}
                          />
                        ))}

                        {/* Drop position indicator */}
                        {isDropTarget && <DropOverlay relX={dropRelX} incompat={dropIncompat} />}

                        {/* Current time line */}
                        {isToday && (
                          <div
                            className="pointer-events-none absolute bottom-0 top-0 z-20 w-[1.5px] bg-[var(--state-error)] opacity-70"
                            style={{ left: `${(nowMins / 1440) * 100}%` }}
                          />
                        )}
                      </div>
                    );
                  })}
                </Fragment>
                  ))}
                </Fragment>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
