import type { FilamentSlot, Printer, PrinterSlotInfo } from "./types";

export const EXTERNAL_SLOT = 254;

export type NormalizedPrinterSlot = {
  slot: number;
  material: string | null;
  color: string | null;
  colorName: string | null;
  brand: string | null;
  filamentId: number | null;
  empty: boolean;
  unitIndex: number | null;
  isExternal: boolean;
};

function fromLive(slot: FilamentSlot, persistent?: PrinterSlotInfo): NormalizedPrinterSlot {
  const color = slot.color || persistent?.hex_color || persistent?.color || null;
  const material = slot.type || persistent?.material || null;
  return {
    slot: slot.slot,
    material,
    color,
    colorName: slot.color_name || persistent?.color || null,
    brand: slot.brand || persistent?.brand || null,
    filamentId: slot.filament_id ?? persistent?.filament_id ?? null,
    empty: slot.empty || (!material && !color && slot.filament_id == null),
    unitIndex: slot.unit_id ?? persistent?.unit_index ?? (slot.slot === EXTERNAL_SLOT ? null : 0),
    isExternal: slot.slot === EXTERNAL_SLOT,
  };
}

function fromPersistent(slot: PrinterSlotInfo): NormalizedPrinterSlot {
  return {
    slot: slot.slot_index,
    material: slot.material,
    color: slot.hex_color || slot.color,
    colorName: slot.color,
    brand: slot.brand,
    filamentId: slot.filament_id,
    empty: slot.state === "empty" || (!slot.material && !slot.color && !slot.hex_color && slot.filament_id == null),
    unitIndex: slot.unit_index ?? (slot.is_external ? null : 0),
    isExternal: slot.is_external || slot.slot_index === EXTERNAL_SLOT,
  };
}

function bambuSource(printer: Printer, slots: NormalizedPrinterSlot[]): "ams" | "external" {
  if (printer.active_tray === EXTERNAL_SLOT) return "external";
  if (printer.active_tray != null && printer.active_tray !== EXTERNAL_SLOT) return "ams";
  if (printer.bambu_has_ams === false) return "external";
  if (printer.bambu_has_ams === true) return "ams";
  return slots.some((slot) => !slot.isExternal) ? "ams" : "external";
}

/**
 * Single UI source of truth for printer slots.
 * Bambu uses live Handy/MQTT colors and merges persistent inventory IDs;
 * U1 always exposes exactly T0..T3 and never an AMS/external slot.
 */
export function normalizedPrinterSlots(printer: Printer): NormalizedPrinterSlot[] {
  const persistent = new Map((printer.slots ?? []).map((slot) => [slot.slot_index, slot]));

  if (printer.kind === "snapmaker_u1") {
    const live = new Map((printer.loaded_filaments ?? []).map((slot) => [slot.slot, slot]));
    return Array.from({ length: 4 }, (_, slot) => {
      const liveSlot = live.get(slot);
      const persistentSlot = persistent.get(slot);
      return liveSlot
        ? fromLive(liveSlot, persistentSlot)
        : persistentSlot
          ? fromPersistent(persistentSlot)
          : {
              slot,
              material: null,
              color: null,
              colorName: null,
              brand: null,
              filamentId: null,
              empty: true,
              unitIndex: 0,
              isExternal: false,
            };
    });
  }

  const liveSlots = (printer.loaded_filaments ?? []).map((slot) => fromLive(slot, persistent.get(slot.slot)));
  const all = liveSlots.length > 0
    ? liveSlots
    : (printer.slots ?? []).map(fromPersistent);
  if (printer.kind !== "bambu") return all.sort((a, b) => a.slot - b.slot);

  const source = bambuSource(printer, all);
  return all
    .filter((slot) => source === "external" ? slot.isExternal : !slot.isExternal)
    .sort((a, b) => a.slot - b.slot);
}
