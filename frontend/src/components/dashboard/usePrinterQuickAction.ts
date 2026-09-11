"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, api } from "@/lib/api";
import type { Printer } from "@/lib/types";

export type PrinterQuickAction = "pause" | "resume" | "cancel" | "clear-error";

/** Shared pause/resume/stop/reset logic for compact & list dashboard views. */
export function usePrinterQuickAction(onUpdated?: (p: Printer) => void) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  async function act(printer: Printer, action: PrinterQuickAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((x) => x.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { act, busy };
}
