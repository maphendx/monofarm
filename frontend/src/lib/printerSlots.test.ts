import { describe, expect, it } from "bun:test";

import type { Printer } from "./types";
import {
  normalizedPrinterSlots,
  preferRealtimePrinters,
  printerSpoolDisplaySlots,
  printerSlotStateKey,
} from "./printerSlots";

const basePrinter = (overrides: Partial<Printer>): Printer => ({
  id: 7,
  name: "Test",
  kind: "bambu",
  moonraker_url: null,
  bambu_dev_id: "dev-7",
  bambu_dev_ip: "192.168.1.7",
  bambu_model: "P1S",
  bambu_lan_mode: true,
  bambu_has_ams: null,
  is_active: true,
  is_out_of_order: false,
  sort_order: 0,
  group_id: null,
  group_name: null,
  loaded_filaments: [],
  state: "idle",
  state_stale: false,
  flags: [],
  job: null,
  eta_minutes: null,
  updated_at: null,
  source: "bambu",
  progress_pct: null,
  extruder_temp: null,
  extruder_target: null,
  bed_temp: null,
  bed_target: null,
  current_filament_meta: null,
  error_msg: null,
  active_tray: null,
  slots: null,
  firmware_version: null,
  power_watts: null,
  firmware_features: null,
  build_x: 256,
  build_y: 256,
  build_z: 256,
  nozzle_diameter: 0.4,
  bed_type: null,
  last_gcode_file_id: null,
  autoprint_mode: "off",
  autoprint_plates_remaining: 0,
  autoprint_cooldown_temp_c: 40,
  autoprint_delay_seconds: 0,
  autoprint_eject_last_plate: true,
  autoprint_error: null,
  tags: [],
  ...overrides,
});

describe("normalized printer slots", () => {
  it("shows only the external spool while Bambu is feeding external", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      active_tray: 254,
      loaded_filaments: [
        { slot: 0, color: "#ff0000", color_name: "Red", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0 },
        { slot: 254, color: "#00ff00", color_name: "Green", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null },
      ],
    }));

    expect(slots.map((slot) => slot.slot)).toEqual([254]);
    expect(slots[0]?.isExternal).toBe(true);
  });

  it("shows AMS slots and hides external while Bambu is feeding AMS", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      active_tray: 1,
      loaded_filaments: [
        { slot: 0, color: "#ff0000", color_name: "Red", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0 },
        { slot: 1, color: "#0000ff", color_name: "Blue", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0 },
        { slot: 254, color: "#00ff00", color_name: "Green", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null },
      ],
    }));

    expect(slots.map((slot) => slot.slot)).toEqual([0, 1]);
    expect(slots.every((slot) => !slot.isExternal)).toBe(true);
  });

  it("keeps Handy live color while preserving the inventory link", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      bambu_has_ams: true,
      slots: [{
        slot_index: 0,
        filament_id: 42,
        material: "PLA",
        color: "Old red",
        hex_color: "#ff0000",
        brand: "Inventory brand",
        grams_at_load: 500,
        state: "loaded",
        unit_index: 0,
        is_external: false,
      }],
      loaded_filaments: [
        { slot: 0, color: "#ff0000", color_name: null, type: "PLA", brand: "Handy brand", filament_id: null, empty: false, unit_id: 0 },
      ],
    }));

    expect(slots[0]).toMatchObject({
      slot: 0,
      color: "#ff0000",
      brand: "Handy brand",
      filamentId: 42,
    });
  });

  it("keeps a persistent assignment when a partial Bambu report omits that slot", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      slots: [{
        slot_index: 0,
        filament_id: 42,
        material: "PLA",
        color: "Red",
        hex_color: "#ff0000",
        brand: "Inventory brand",
        grams_at_load: 500,
        state: "loaded",
        unit_index: 0,
        is_external: false,
      }],
      loaded_filaments: [
        { slot: 254, color: "#00ff00", color_name: "Green", type: "PETG", brand: null, filament_id: null, empty: false, unit_id: null },
      ],
    }), { allSources: true });

    expect(slots.map((slot) => slot.slot)).toEqual([0, 254]);
    expect(slots[0]?.filamentId).toBe(42);
  });

  it("drops a persistent inventory assignment when Handy reports a different spool", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      slots: [{
        slot_index: 0,
        filament_id: 42,
        material: "PLA",
        color: "Red",
        hex_color: "#ff0000",
        brand: "Inventory brand",
        grams_at_load: 500,
        state: "loaded",
        unit_index: 0,
        is_external: false,
      }],
      loaded_filaments: [
        { slot: 0, color: "#0000ff", color_name: "Blue", type: "PETG", brand: "Handy brand", filament_id: null, empty: false, unit_id: 0, verified: true },
      ],
    }), { allSources: true });

    expect(slots[0]?.filamentId).toBeNull();
    expect(slots[0]?.color).toBe("#0000ff");
  });

  it("always exposes exactly four static U1 tool slots", () => {
    const slots = normalizedPrinterSlots(basePrinter({
      kind: "snapmaker_u1",
      bambu_dev_id: null,
      bambu_dev_ip: null,
      bambu_model: null,
      moonraker_url: "http://u1.local",
      source: "moonraker",
      loaded_filaments: [
        { slot: 2, color: "#abcdef", color_name: "Custom", type: "PETG", brand: null, filament_id: null, empty: false, unit_id: null },
      ],
    }));

    expect(slots.map((slot) => slot.slot)).toEqual([0, 1, 2, 3]);
    expect(slots.filter((slot) => slot.empty).map((slot) => slot.slot)).toEqual([0, 1, 3]);
    expect(slots.every((slot) => !slot.isExternal && slot.unitIndex === 0)).toBe(true);
  });

  it("renders U1 printer colors even when persistent inventory slots are empty", () => {
    const slots = printerSpoolDisplaySlots(basePrinter({
      kind: "snapmaker_u1",
      bambu_dev_id: null,
      bambu_dev_ip: null,
      bambu_model: null,
      moonraker_url: "http://u1.local/",
      source: "moonraker",
      slots: Array.from({ length: 4 }, (_, slot_index) => ({
        slot_index,
        filament_id: null,
        material: null,
        color: null,
        hex_color: null,
        brand: null,
        grams_at_load: null,
        state: "empty" as const,
        unit_index: 0,
        is_external: false,
      })),
      loaded_filaments: [
        { slot: 0, color: "#8BD5EE", color_name: null, type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null, verified: true },
        { slot: 1, color: "#F55A7C", color_name: null, type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null, verified: true },
        { slot: 2, color: "#FFFFFF", color_name: null, type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null, verified: true },
        { slot: 3, color: "#000000", color_name: null, type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null, verified: true },
      ],
    }));

    expect(slots.map((slot) => slot.color)).toEqual(["#8BD5EE", "#F55A7C", "#FFFFFF", "#000000"]);
    expect(slots.every((slot) => !slot.empty && slot.verified)).toBe(true);
  });
});

describe("realtime printer snapshots", () => {
  it("keeps the REST snapshot until the first WebSocket snapshot is ready", () => {
    const rest = [basePrinter({ loaded_filaments: [
      { slot: 0, color: "#ff0000", color_name: "Red", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0 },
    ] })];
    const cachedStream = [basePrinter({ loaded_filaments: [] })];

    expect(preferRealtimePrinters(rest, cachedStream, true)).toBe(rest);
  });

  it("uses the WebSocket snapshot once it contains the printer's current AMS", () => {
    const rest = [basePrinter({ loaded_filaments: [] })];
    const realtime = [basePrinter({ loaded_filaments: [
      { slot: 1, color: "#0000ff", color_name: "Blue", type: "PETG", brand: null, filament_id: null, empty: false, unit_id: 0, verified: true },
    ] })];

    const selected = preferRealtimePrinters(rest, realtime, false);

    expect(selected).toBe(realtime);
    expect(selected[0]?.loaded_filaments[0]?.color).toBe("#0000ff");
  });

  it("changes the mapping key for AMS changes but not print progress", () => {
    const printer = basePrinter({ loaded_filaments: [
      { slot: 0, color: "#ff0000", color_name: "Red", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0, verified: true },
    ] });
    const changedAms = basePrinter({ loaded_filaments: [
      { slot: 0, color: "#0000ff", color_name: "Blue", type: "PETG", brand: null, filament_id: null, empty: false, unit_id: 0, verified: true },
    ] });

    expect(printerSlotStateKey({ ...printer, progress_pct: 50 })).toBe(printerSlotStateKey(printer));
    expect(printerSlotStateKey(changedAms)).not.toBe(printerSlotStateKey(printer));
  });
});
