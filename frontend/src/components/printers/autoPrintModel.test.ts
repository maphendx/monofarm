import { describe, expect, it } from "bun:test";

import { buildAutoPrintSummary } from "./autoPrintModel";

describe("AutoPrint operator summary", () => {
  it("shows the active copy and remaining printer workload", () => {
    const summary = buildAutoPrintSummary({
      enabled: true,
      plates_remaining: 4,
      active_job_status: "printing",
      active_job_progress_pct: 42,
      error: null,
      entries: [
        {
          id: 11,
          title: "Gear set",
          file_name: "gear-set.3mf",
          runs_total: 5,
          runs_completed: 1,
          active_run_index: 2,
          is_active: true,
        },
        {
          id: 12,
          title: "Hook",
          file_name: "hook.3mf",
          runs_total: 2,
          runs_completed: 0,
          active_run_index: null,
          is_active: false,
        },
      ],
    });

    expect(summary.current?.file_name).toBe("gear-set.3mf");
    expect(summary.currentCopy).toBe(2);
    expect(summary.totalRunsRemaining).toBe(6);
    expect(summary.fileCount).toBe(2);
    expect(summary.plateShortage).toBe(2);
  });

  it("uses the first queued file when no run is active", () => {
    const summary = buildAutoPrintSummary({
      enabled: true,
      plates_remaining: 3,
      active_job_status: null,
      active_job_progress_pct: null,
      error: null,
      entries: [{
        id: 21,
        title: "Queued part",
        file_name: "queued.3mf",
        runs_total: 3,
        runs_completed: 1,
        active_run_index: null,
        is_active: false,
      }],
    });

    expect(summary.current?.id).toBe(21);
    expect(summary.currentCopy).toBe(2);
    expect(summary.plateShortage).toBe(0);
  });
});
