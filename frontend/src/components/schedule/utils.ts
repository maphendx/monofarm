/** Shared utilities for schedule/calendar components. */

import type { CalendarEntry, CalendarLane } from "@/lib/types";

// ── Time helpers ──────────────────────────────────────────────────────────────

/** Parse "HH:MM:SS" or "HH:MM" → total minutes from midnight. */
export function parseTimeMins(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

/** Format total minutes → "HH:MM" (wraps at 1440). */
export function fmtTimeMins(totalMins: number): string {
  const m = ((totalMins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Format a duration in minutes → "2г 30хв", "45хв", "2г". */
export function fmtDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}г ${m}хв`;
  if (h) return `${h}г`;
  return `${m}хв`;
}

function parseDurationFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text.replace(/[_-]+/g, " ");

  const hoursMatch = normalized.match(/(?:^|[^\d])(\d{1,2})\s*(?:h|hr|hrs|hour|hours|г|год|ч)\s*(?:(\d{1,2})\s*(?:m|min|mins|minute|minutes|хв|м))?/iu);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1] ?? 0);
    const mins = Number(hoursMatch[2] ?? 0);
    const total = hours * 60 + mins;
    return total > 0 ? total : null;
  }

  const minsMatch = normalized.match(/(?:^|[^\d])(\d{1,4})\s*(?:m|min|mins|minute|minutes|хв)(?:[^\p{L}]|$)/iu);
  if (minsMatch) {
    const mins = Number(minsMatch[1] ?? 0);
    return mins > 0 ? mins : null;
  }

  return null;
}

export function getEntryDurationMins(entry: CalendarEntry): number {
  if (entry.task.estimated_minutes && entry.task.estimated_minutes > 0) {
    return entry.task.estimated_minutes;
  }
  if (entry.task.filament_meta?.estimated_minutes && entry.task.filament_meta.estimated_minutes > 0) {
    return entry.task.filament_meta.estimated_minutes;
  }
  return (
    parseDurationFromText(entry.task.file_name) ??
    parseDurationFromText(entry.task.title) ??
    0
  );
}

function getEntryEndMins(entry: CalendarEntry, startMins: number, durationMins: number): number {
  if (!entry.end_time) return startMins + durationMins;

  let endMins = parseTimeMins(entry.end_time);
  if (endMins <= startMins) endMins += 1440;

  const computedEnd = startMins + durationMins;
  const backendLooksMidnightCapped = durationMins > 0 && computedEnd > 1440 && endMins <= 1440;
  if (backendLooksMidnightCapped) return computedEnd;

  return endMins;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Date → "YYYY-MM-DD" in local time (avoids UTC shift). */
export function isoDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Return Monday of the week containing d. */
export function getMondayOfWeek(d: Date = new Date()): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
  return r;
}

/** Return 7 Date objects Mon–Sun for the given Monday. */
export function getWeekDates(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

// ── Calendar block model ──────────────────────────────────────────────────────

export interface CalendarBlock {
  entry: CalendarEntry;
  printerId: number;
  dayIndex: number;         // 0–6 within the displayed week
  startMins: number;        // minutes from 00:00 within this day
  endMins: number;          // may exceed 1440 for cross-midnight blocks
  isContinuation: boolean;  // always false now (kept for type compat)
  totalDurationMins: number;
}

type BlockMapKey = `${number}-${number}`; // `${printerId}-${dayIndex}`

export interface ScheduleInterval {
  startMins: number;
  endMins: number;
  entryId?: number;
}

const SNAP_THRESHOLD_MINS = 20;

/**
 * Find the first non-overlapping start at or after the requested position.
 *
 * Dropping inside an existing block means "append after this block". A nearby
 * block end is also magnetic so operators do not need pixel-perfect dragging.
 */
export function findAvailableStart(
  requestedStartMins: number,
  durationMins: number,
  intervals: ScheduleInterval[],
  ignoredEntryId?: number,
): number {
  const duration = Math.max(1, durationMins);
  const occupied = intervals
    .filter((interval) =>
      (ignoredEntryId === undefined || interval.entryId !== ignoredEntryId) &&
      interval.endMins > interval.startMins
    )
    .toSorted((a, b) => a.startMins - b.startMins);

  let candidate = Math.max(0, requestedStartMins);
  const containing = occupied.find(
    (interval) => candidate >= interval.startMins && candidate < interval.endMins,
  );
  if (containing) {
    candidate = containing.endMins;
  } else {
    let nearestEnd: number | null = null;
    let nearestDistance = SNAP_THRESHOLD_MINS + 1;
    for (const interval of occupied) {
      const distance = Math.abs(candidate - interval.endMins);
      if (distance <= SNAP_THRESHOLD_MINS && distance < nearestDistance) {
        nearestEnd = interval.endMins;
        nearestDistance = distance;
      }
    }
    if (nearestEnd !== null) candidate = nearestEnd;
  }

  while (true) {
    const conflict = occupied.find(
      (interval) =>
        candidate < interval.endMins &&
        candidate + duration > interval.startMins,
    );
    if (!conflict) return candidate;
    candidate = conflict.endMins;
  }
}

/** Lay out repeated copies back-to-back while skipping existing work. */
export function findSequentialStarts(
  requestedStartMins: number,
  durationMins: number,
  quantity: number,
  intervals: ScheduleInterval[],
): number[] {
  const duration = Math.max(1, durationMins);
  const occupied = [...intervals];
  const starts: number[] = [];
  let cursor = requestedStartMins;

  for (let i = 0; i < Math.max(1, quantity); i += 1) {
    const start = findAvailableStart(cursor, duration, occupied);
    starts.push(start);
    occupied.push({ startMins: start, endMins: start + duration });
    cursor = start + duration;
  }

  return starts;
}

/** Convert one printer's calendar rows into week-relative occupied intervals. */
export function buildPrinterScheduleIntervals(
  lanes: CalendarLane[],
  weekDates: Date[],
  printerId: number,
): ScheduleInterval[] {
  const weekStrs = weekDates.map(isoDateStr);
  const lane = lanes.find((item) => item.printer_id === printerId);
  if (!lane) return [];

  const intervals: ScheduleInterval[] = [];
  for (const day of lane.days) {
    const dayIndex = weekStrs.indexOf(day.plan_date);
    if (dayIndex === -1) continue;

    for (const entry of day.entries) {
      if (!entry.start_time) continue;
      const localStart = parseTimeMins(entry.start_time);
      const duration = Math.max(1, getEntryDurationMins(entry));
      intervals.push({
        startMins: dayIndex * 1440 + localStart,
        endMins: dayIndex * 1440 + localStart + duration,
        entryId: entry.id,
      });
    }
  }

  return intervals;
}

/**
 * Pre-process lanes into positioned blocks for the calendar grid.
 *
 * Cross-midnight entries produce a SINGLE block whose endMins exceeds 1440.
 * The cell uses `overflow: visible` so the block visually spills into the
 * next day column — no splitting, no duplicate continuation blocks.
 */
export function buildCalendarBlocks(
  lanes: CalendarLane[],
  weekDates: Date[],
): Map<BlockMapKey, CalendarBlock[]> {
  const weekStrs = weekDates.map(isoDateStr);
  const map = new Map<BlockMapKey, CalendarBlock[]>();

  const push = (printerId: number, dayIdx: number, block: CalendarBlock) => {
    const key: BlockMapKey = `${printerId}-${dayIdx}`;
    const arr = map.get(key) ?? [];
    arr.push(block);
    map.set(key, arr);
  };

  for (const lane of lanes) {
    for (const day of lane.days) {
      const dayIdx = weekStrs.indexOf(day.plan_date);
      if (dayIdx === -1) continue;

      for (const entry of day.entries) {
        if (!entry.start_time) continue; // untimed/asap — rendered separately

        const startMins = parseTimeMins(entry.start_time);
        const duration = getEntryDurationMins(entry);
        const totalEndMins = getEntryEndMins(entry, startMins, duration);
        const totalDurationMins = Math.max(0, totalEndMins - startMins);

        // Single block — even if totalEndMins > 1440 the block overflows
        push(lane.printer_id, dayIdx, {
          entry, printerId: lane.printer_id,
          dayIndex: dayIdx,
          startMins, endMins: totalEndMins,
          isContinuation: false, totalDurationMins,
        });
      }
    }
  }

  return map;
}

/**
 * Collect untimed (asap / no start_time) entries per (printerId, dayIndex).
 */
export function buildUntimedMap(
  lanes: CalendarLane[],
  weekDates: Date[],
): Map<BlockMapKey, CalendarEntry[]> {
  const weekStrs = weekDates.map(isoDateStr);
  const map = new Map<BlockMapKey, CalendarEntry[]>();

  for (const lane of lanes) {
    for (const day of lane.days) {
      const dayIdx = weekStrs.indexOf(day.plan_date);
      if (dayIdx === -1) continue;
      for (const entry of day.entries) {
        if (entry.start_time) continue;
        const key: BlockMapKey = `${lane.printer_id}-${dayIdx}`;
        const arr = map.get(key) ?? [];
        arr.push(entry);
        map.set(key, arr);
      }
    }
  }

  return map;
}
