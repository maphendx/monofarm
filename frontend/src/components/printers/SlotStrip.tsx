"use client";

import type { PrinterKind, PrinterSlotInfo } from "@/lib/types";

// Returns slots grouped by AMS unit for Bambu, or a single group for Klipper/other
function groupByUnit(slots: PrinterSlotInfo[]): PrinterSlotInfo[][] {
  const external = slots.filter((s) => s.is_external);
  const normal = slots.filter((s) => !s.is_external);

  const units = new Map<number, PrinterSlotInfo[]>();
  for (const s of normal) {
    const u = s.unit_index ?? 0;
    if (!units.has(u)) units.set(u, []);
    units.get(u)!.push(s);
  }

  const groups: PrinterSlotInfo[][] = [];
  const sortedUnits = [...units.keys()].sort();
  for (const u of sortedUnits) {
    groups.push(units.get(u)!.sort((a, b) => a.slot_index - b.slot_index));
  }
  if (external.length) groups.push(external);
  return groups;
}

function SlotDot({ slot, label }: { slot: PrinterSlotInfo; label?: string }) {
  const isEmpty = slot.state === "empty" || !slot.filament_id;
  const isRunout = slot.state === "runout";
  const isError = slot.state === "error";
  const hex = slot.hex_color ?? (slot.color?.startsWith("#") ? slot.color : null);

  const tooltipParts = [
    label,
    isEmpty
      ? "порожній"
      : [
          slot.material,
          slot.brand,
          slot.grams_at_load ? `${slot.grams_at_load}г` : null,
          isRunout ? "RUNOUT" : null,
        ]
          .filter(Boolean)
          .join(" · "),
  ]
    .filter(Boolean)
    .join(": ");

  return (
    <span
      title={tooltipParts}
      className={[
        "relative size-3 shrink-0 rounded-full ring-1",
        isEmpty
          ? "ring-[var(--border)] bg-[var(--bg-elevated)]"
          : isRunout || isError
            ? "ring-[var(--state-error)]"
            : "ring-[var(--border-strong)]",
      ].join(" ")}
      style={hex && !isEmpty ? { backgroundColor: hex } : undefined}
    >
      {(isRunout || isError) && !isEmpty && (
        <span className="absolute inset-0 rounded-full bg-[var(--state-error)] opacity-70" />
      )}
    </span>
  );
}

function slotLabel(slot: PrinterSlotInfo, kind: PrinterKind): string {
  if (slot.is_external) return "External";
  if (kind === "bambu") {
    const unit = slot.unit_index ?? 0;
    const tray = slot.slot_index - unit * 4;
    return `AMS${unit + 1}-T${tray + 1}`;
  }
  return `T${slot.slot_index + 1}`;
}

interface SlotStripProps {
  slots: PrinterSlotInfo[];
  kind: PrinterKind;
}

/**
 * Universal slot strip — compact dot row for printer cards and detail views.
 * U1: single group of 4 toolhead dots.
 * Bambu: dots grouped by AMS unit, external spool appended.
 * other: sorted list.
 */
export function SlotStrip({ slots, kind }: SlotStripProps) {
  if (!slots.length) return null;

  const groups = kind === "bambu" ? groupByUnit(slots) : [slots];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {groups.map((group, gi) => (
        <div key={gi} className="flex gap-1">
          {group.map((s) => (
            <SlotDot key={s.slot_index} slot={s} label={slotLabel(s, kind)} />
          ))}
        </div>
      ))}
    </div>
  );
}
