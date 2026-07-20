import { useSyncExternalStore } from "react";

import type { BambuCloudJob, BambuCloudJobStatus } from "./types";

const STORAGE_KEY = "monofarm_active_print_transfers";

export const PRINT_TRANSFER_DISMISS_MS = 3500;

const PRINT_TRANSFER_FINISHED_STATUSES = new Set<BambuCloudJobStatus>([
  "acknowledged",
  "printing",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "lost",
]);

export type PrintTransfer = {
  jobId: number;
  printerId: number | null;
  printerName: string;
  fileName: string;
  dispatchMode?: string;
  status: BambuCloudJobStatus;
  statusReason: string | null;
  progressPct: number | null;
  errorMessage: string | null;
  isActive: boolean;
};

type TransferSeed = Pick<PrintTransfer, "jobId" | "printerId" | "printerName" | "fileName"> & {
  dispatchMode?: string;
  status?: BambuCloudJobStatus;
};

function loadSnapshot(): PrintTransfer[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PrintTransfer => (
      item && typeof item.jobId === "number" && item.isActive === true
    ));
  } catch {
    return [];
  }
}

let snapshot: PrintTransfer[] = loadSnapshot();
const listeners = new Set<() => void>();

function notify() {
  snapshot = [...snapshot];
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.filter((item) => item.isActive)));
    }
  } catch {
    // Storage can be unavailable in private browsing or restricted webviews.
  }
  listeners.forEach((listener) => listener());
}

export function subscribePrintTransfers(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPrintTransfers() {
  return snapshot;
}

export function getPrintTransferDismissKey(transfers: PrintTransfer[]) {
  return transfers
    .filter((transfer) => !transfer.isActive || PRINT_TRANSFER_FINISHED_STATUSES.has(transfer.status))
    .map((transfer) => transfer.jobId)
    .sort((a, b) => a - b)
    .join(",");
}

export function usePrintTransfers() {
  return useSyncExternalStore(subscribePrintTransfers, getPrintTransfers, () => []);
}

export function trackPrintTransfer(seed: TransferSeed) {
  const existing = snapshot.find((transfer) => transfer.jobId === seed.jobId);
  const transfer: PrintTransfer = {
    jobId: seed.jobId,
    printerId: seed.printerId,
    printerName: seed.printerName,
    fileName: seed.fileName,
    dispatchMode: seed.dispatchMode,
    status: seed.status ?? "queued",
    statusReason: null,
    progressPct: null,
    errorMessage: null,
    isActive: true,
  };
  snapshot = existing
    ? snapshot.map((item) => item.jobId === seed.jobId ? { ...item, ...transfer } : item)
    : [...snapshot, transfer];
  notify();
}

export function updatePrintTransfer(job: BambuCloudJob) {
  const current = snapshot.find((transfer) => transfer.jobId === job.id);
  if (!current) return;
  snapshot = snapshot.map((transfer) => transfer.jobId === job.id ? {
    ...transfer,
    printerId: job.printer_id,
    printerName: job.printer_name ?? transfer.printerName,
    fileName: job.file_name ?? transfer.fileName,
    dispatchMode: job.dispatch_mode,
    status: job.status,
    statusReason: job.status_reason,
    progressPct: job.progress_pct,
    errorMessage: job.error_message,
    isActive: job.is_active,
  } : transfer);
  notify();
}

export function dismissPrintTransfer(jobId: number) {
  snapshot = snapshot.filter((transfer) => transfer.jobId !== jobId);
  notify();
}
