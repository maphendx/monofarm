"use client";

import { normalizedPrinterSlots } from "@/lib/printerSlots";
import type { Printer } from "@/lib/types";

/** Compact filament swatch dots (+N overflow) shared by compact & list views. */
export function FilamentDots({ printer, max = 4 }: { printer: Printer; max?: number }) {
  const slots = normalizedPrinterSlots(printer).filter((s) => !s.empty);
  if (slots.length === 0) return null;
  const shown = slots.slice(0, max);
  const active = printer.active_tray != null ? slots.find((s) => s.slot === printer.active_tray) : undefined;
  const material = active?.material ?? slots[0]?.material ?? null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {material && (
        <span className="shrink-0 rounded border border-[var(--border)] px-1 py-px font-mono text-[9px] uppercase leading-none text-[var(--text-muted)]">
          {material}
        </span>
      )}
      {shown.map((s) => (
        <span
          key={`${s.isExternal ? "e" : "s"}-${s.slot}`}
          title={s.colorName ?? s.material ?? undefined}
          className="size-2.5 shrink-0 rounded-full border border-[rgba(0,0,0,.3)]"
          style={{ background: s.color ?? "#888888" }}
        />
      ))}
      {slots.length > shown.length && (
        <span className="shrink-0 font-mono text-[9px] text-[var(--text-faint)]">+{slots.length - shown.length}</span>
      )}
    </span>
  );
}
