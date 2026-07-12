import type { AutoPrintQueueEntry, AutoPrintStatus } from "@/lib/types";

export interface AutoPrintSummary {
  current: AutoPrintQueueEntry | null;
  currentCopy: number | null;
  totalRunsRemaining: number;
  fileCount: number;
  plateShortage: number;
}

export function buildAutoPrintSummary(status: AutoPrintStatus): AutoPrintSummary {
  const entries = status.entries.filter((entry) => entry.runs_completed < entry.runs_total);
  const current = entries.find((entry) => entry.is_active) ?? entries[0] ?? null;
  const totalRunsRemaining = entries.reduce(
    (total, entry) => total + Math.max(0, entry.runs_total - entry.runs_completed),
    0,
  );

  return {
    current,
    currentCopy: current
      ? current.active_run_index ?? Math.min(current.runs_total, current.runs_completed + 1)
      : null,
    totalRunsRemaining,
    fileCount: entries.length,
    plateShortage: Math.max(0, totalRunsRemaining - status.plates_remaining),
  };
}
