import type { FilamentSlot, Printer, PrinterSlotInfo } from "./types";

export const EXTERNAL_SLOT = 254;

/** Prefer the first complete WebSocket snapshot over a page's one-time REST fallback. */
export function preferRealtimePrinters(
  restPrinters: Printer[],
  realtimePrinters: Printer[],
  realtimeLoading: boolean,
): Printer[] {
  return realtimeLoading ? restPrinters : realtimePrinters;
}

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
  /** Confirmed by the printer's own MQTT report (Bambu). Always true outside that pathway. */
  verified: boolean;
};

export type PrinterSpoolDisplaySlot = {
  slot: number;
  empty: boolean;
  color: string;
  colorName: string | null;
  material: string | null;
  brand: string | null;
  filamentId: number | null;
  verified: boolean;
};

function fromLive(slot: FilamentSlot, persistent?: PrinterSlotInfo): NormalizedPrinterSlot {
  const color = slot.color || persistent?.hex_color || persistent?.color || null;
  const material = slot.type || persistent?.material || null;
  const persistentColor = (persistent?.hex_color || persistent?.color || "").toLowerCase().slice(0, 7);
  const liveColor = (slot.color || "").toLowerCase().slice(0, 7);
  const samePhysicalSpool = Boolean(
    persistent &&
    !slot.empty &&
    persistent.material &&
    persistent.material.toUpperCase() === (slot.type || "").toUpperCase() &&
    persistentColor &&
    persistentColor === liveColor,
  );
  const keepPersistent = slot.verified === false || samePhysicalSpool;
  return {
    slot: slot.slot,
    material,
    color,
    colorName: slot.color_name || (keepPersistent ? persistent?.color : null) || null,
    brand: slot.brand || (keepPersistent ? persistent?.brand : null) || null,
    filamentId: slot.filament_id ?? (keepPersistent ? persistent?.filament_id : null) ?? null,
    empty: slot.empty || (!material && !color && slot.filament_id == null),
    unitIndex: slot.unit_id ?? persistent?.unit_index ?? (slot.slot === EXTERNAL_SLOT ? null : 0),
    isExternal: slot.slot === EXTERNAL_SLOT,
    verified: slot.verified ?? true,
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
    verified: true,
  };
}

function bambuSource(printer: Printer, slots: NormalizedPrinterSlot[]): "ams" | "external" {
  if (printer.bambu_has_ams === false) return "external";
  if (printer.active_tray === EXTERNAL_SLOT) return "external";
  if (printer.active_tray != null && printer.active_tray !== EXTERNAL_SLOT) return "ams";
  if (printer.bambu_has_ams === true) return "ams";
  return slots.some((slot) => !slot.isExternal) ? "ams" : "external";
}

/**
 * Single UI source of truth for printer slots.
 * Bambu uses live Handy/MQTT colors and merges persistent inventory IDs;
 * U1 always exposes exactly T0..T3 and never an AMS/external slot.
 */
export function normalizedPrinterSlots(
  printer: Printer,
  opts?: { allSources?: boolean },
): NormalizedPrinterSlot[] {
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
              verified: true,
            };
    });
  }

  const liveSlotIndexes = new Set((printer.loaded_filaments ?? []).map((slot) => slot.slot));
  const liveSlots = (printer.loaded_filaments ?? []).map((slot) => fromLive(slot, persistent.get(slot.slot)));
  const persistentOnly = (printer.slots ?? [])
    .filter((slot) => !liveSlotIndexes.has(slot.slot_index))
    .map(fromPersistent);
  const all = [...liveSlots, ...persistentOnly];
  if (printer.kind !== "bambu") return all.sort((a, b) => a.slot - b.slot);

  if (printer.bambu_has_ams === false) {
    const external = all.filter((slot) => slot.isExternal);
    if (external.length === 0) {
      return [{
        slot: EXTERNAL_SLOT,
        material: null,
        color: null,
        colorName: null,
        brand: null,
        filamentId: null,
        empty: true,
        unitIndex: null,
        isExternal: true,
        verified: false,
      }];
    }
    return external.sort((a, b) => a.slot - b.slot);
  }

  if (opts?.allSources) return all.sort((a, b) => a.slot - b.slot);

  const source = bambuSource(printer, all);
  return all
    .filter((slot) => source === "external" ? slot.isExternal : !slot.isExternal)
    .sort((a, b) => a.slot - b.slot);
}

/** Printer-first slot data shaped for reel/spool presentation components. */
export function printerSpoolDisplaySlots(printer: Printer): PrinterSpoolDisplaySlot[] {
  return normalizedPrinterSlots(printer, { allSources: true }).map((slot) => ({
    slot: slot.slot,
    empty: slot.empty,
    color: slot.color ?? "#888888",
    colorName: slot.colorName,
    material: slot.material,
    brand: slot.brand,
    filamentId: slot.filamentId,
    verified: slot.verified,
  }));
}

/** Stable key for changes that can alter AMS display/mapping, excluding print progress. */
export function printerSlotStateKey(printer: Printer): string {
  return normalizedPrinterSlots(printer, { allSources: true })
    .map((slot) => [
      slot.slot,
      slot.unitIndex,
      slot.isExternal ? 1 : 0,
      slot.verified ? 1 : 0,
      slot.empty ? 1 : 0,
      slot.material ?? "",
      slot.color ?? "",
    ].join(":"))
    .join("|");
}
