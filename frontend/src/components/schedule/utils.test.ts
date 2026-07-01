import { describe, expect, test } from "bun:test";

import {
  buildCalendarBlocks,
  buildPrinterScheduleIntervals,
  buildUntimedMap,
  findAvailableStart,
  findSequentialStarts,
  fmtDuration,
  fmtTimeMins,
  getEntryDurationMins,
  getMondayOfWeek,
  getWeekDates,
  isoDateStr,
  parseTimeMins,
  type ScheduleInterval,
} from "./utils";
import type { CalendarEntry, CalendarLane } from "@/lib/types";

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 1,
    plan_date: "2026-06-29",
    printer_id: 7,
    printer_name: "U1",
    task_id: 10,
    task: {
      id: 10,
      title: "part.gcode",
      estimated_minutes: 60,
      filament_meta: null,
    },
    sequence: 0,
    note: null,
    done: false,
    created_at: "2026-06-29T08:00:00Z",
    start_time: "08:00:00",
    end_time: "09:00:00",
    schedule_mode: "exact_time",
    window_start_at: null,
    window_end_at: null,
    priority: 0,
    blocked_reason: null,
    conflict: false,
    ...overrides,
  } as CalendarEntry;
}

function makeLane(entries: CalendarEntry[]): CalendarLane {
  return {
    printer_id: 7,
    printer_name: "U1",
    printer_kind: "snapmaker_u1",
    group_id: null,
    group_name: null,
    group_color: null,
    days: [{
      printer_id: 7,
      printer_name: "U1",
      plan_date: "2026-06-29",
      entries,
    }],
  };
}

describe("time and date helpers", () => {
  test("parses and formats times and durations", () => {
    expect(parseTimeMins("17:22:00")).toBe(17 * 60 + 22);
    expect(fmtTimeMins(24 * 60 + 31)).toBe("00:31");
    expect(fmtDuration(150)).toBe("2г 30хв");
    expect(fmtDuration(120)).toBe("2г");
    expect(fmtDuration(45)).toBe("45хв");
    expect(fmtDuration(null)).toBe("");
  });

  test("uses task metadata and filename duration fallbacks", () => {
    expect(getEntryDurationMins(makeEntry())).toBe(60);
    expect(getEntryDurationMins(makeEntry({
      task: {
        ...makeEntry().task,
        estimated_minutes: null,
        filament_meta: { estimated_minutes: 75 },
      },
    }))).toBe(75);
    expect(getEntryDurationMins(makeEntry({
      task: {
        ...makeEntry().task,
        title: "fallback",
        file_name: "part_18h9m.gcode",
        estimated_minutes: null,
        filament_meta: null,
      },
    }))).toBe(18 * 60 + 9);
  });

  test("reserves calendar time for every AutoPrint run", () => {
    const entry = makeEntry({
      runs_total: 4,
      task: {
        ...makeEntry().task,
        estimated_minutes: 30,
      },
    });

    expect(getEntryDurationMins(entry)).toBe(120);
  });

  test("builds stable local calendar dates", () => {
    const monday = new Date(2026, 5, 29, 12);
    expect(isoDateStr(monday)).toBe("2026-06-29");
    expect(isoDateStr(getMondayOfWeek(new Date(2026, 6, 1, 12)))).toBe("2026-06-29");
    expect(getWeekDates(monday).map(isoDateStr)).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });
});

describe("calendar block maps", () => {
  const weekDates = getWeekDates(new Date(2026, 5, 29, 12));

  test("keeps a cross-midnight print as one overflowing block", () => {
    const entry = makeEntry({
      start_time: "17:22:00",
      end_time: "23:59:59",
      task: { ...makeEntry().task, estimated_minutes: 18 * 60 + 9 },
    });
    const blocks = buildCalendarBlocks([makeLane([entry])], weekDates);

    expect(blocks.get("7-0")).toHaveLength(1);
    expect(blocks.get("7-0")?.[0].endMins).toBe(17 * 60 + 22 + 18 * 60 + 9);
  });

  test("separates timed and untimed entries", () => {
    const untimed = makeEntry({ id: 2, start_time: null, end_time: null });
    const lanes = [makeLane([makeEntry(), untimed])];

    expect(buildCalendarBlocks(lanes, weekDates).get("7-0")).toHaveLength(1);
    expect(buildUntimedMap(lanes, weekDates).get("7-0")).toEqual([untimed]);
  });

  test("builds absolute occupied intervals for one printer", () => {
    const intervals = buildPrinterScheduleIntervals(
      [makeLane([makeEntry({ id: 42, start_time: "17:22:00" })])],
      weekDates,
      7,
    );

    expect(intervals).toEqual([{
      startMins: 17 * 60 + 22,
      endMins: 18 * 60 + 22,
      entryId: 42,
    }]);
    expect(buildPrinterScheduleIntervals([], weekDates, 7)).toEqual([]);
  });
});

describe("findAvailableStart", () => {
  test("places a dropped job directly after the block it overlaps", () => {
    const intervals: ScheduleInterval[] = [
      { startMins: 8 * 60, endMins: 10 * 60 },
    ];

    expect(findAvailableStart(9 * 60, 60, intervals)).toBe(10 * 60);
  });

  test("keeps a requested start when the job fits in a free gap", () => {
    const intervals: ScheduleInterval[] = [
      { startMins: 8 * 60, endMins: 9 * 60 },
      { startMins: 12 * 60, endMins: 13 * 60 },
    ];

    expect(findAvailableStart(10 * 60, 60, intervals)).toBe(10 * 60);
  });

  test("moves past every overlapping block, including cross-midnight jobs", () => {
    const intervals: ScheduleInterval[] = [
      { startMins: 23 * 60, endMins: 26 * 60 },
      { startMins: 26 * 60, endMins: 27 * 60 },
    ];

    expect(findAvailableStart(23 * 60 + 30, 90, intervals)).toBe(27 * 60);
  });

  test("ignores the block currently being moved", () => {
    const intervals: ScheduleInterval[] = [
      { startMins: 8 * 60, endMins: 10 * 60, entryId: 11 },
      { startMins: 12 * 60, endMins: 13 * 60, entryId: 12 },
    ];

    expect(findAvailableStart(8 * 60, 60, intervals, 11)).toBe(8 * 60);
  });
});

describe("findSequentialStarts", () => {
  test("lays out every copy back-to-back in the same day when they fit", () => {
    expect(findSequentialStarts(8 * 60, 90, 3, [])).toEqual([
      8 * 60,
      9 * 60 + 30,
      11 * 60,
    ]);
  });

  test("continues on the next day without resetting to the original time", () => {
    expect(findSequentialStarts(17 * 60 + 22, 18 * 60 + 9, 2, [])).toEqual([
      17 * 60 + 22,
      24 * 60 + 11 * 60 + 31,
    ]);
  });

  test("skips existing work while preserving order between copies", () => {
    const intervals: ScheduleInterval[] = [
      { startMins: 9 * 60, endMins: 10 * 60 },
    ];

    expect(findSequentialStarts(8 * 60, 60, 3, intervals)).toEqual([
      8 * 60,
      10 * 60,
      11 * 60,
    ]);
  });
});
