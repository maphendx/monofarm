import { describe, expect, it } from "bun:test";

import type { Printer } from "@/lib/types";
import {
  canSkipObject,
  formatEtaShort,
  formatFinishTime,
  printerCanStartPrint,
  getPrinterCardTone,
  getSlotNumber,
  printerCardUsesPersistentSlots,
  printerNeedsClearBed,
  printerCover,
} from "./printerCardModel";

const printer = (overrides: Partial<Printer> = {}): Printer => ({
  id: 1,
  name: "U1",
  kind: "snapmaker_u1",
  moonraker_url: "http://moonraker.local",
  bambu_dev_id: null,
  bambu_dev_ip: null,
  bambu_model: null,
  bambu_lan_mode: false,
  is_active: true,
  is_out_of_order: false,
  sort_order: 0,
  group_id: null,
  group_name: null,
  loaded_filaments: [],
  state: "idle",
  flags: [],
  job: null,
  eta_minutes: null,
  updated_at: null,
  source: "moonraker",
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
  build_x: null,
  build_y: null,
  build_z: null,
  nozzle_diameter: null,
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

describe("printer card model", () => {
  it("maps operational states to the visual card themes", () => {
    expect(getPrinterCardTone(printer({ state: "printing" }))).toBe("printing");
    expect(getPrinterCardTone(printer({ state: "paused" }))).toBe("paused");
    expect(getPrinterCardTone(printer({ state: "awaiting_bed_clear" }))).toBe("collect");
    expect(getPrinterCardTone(printer({ state: "error" }))).toBe("error");
    expect(getPrinterCardTone(printer({ state: "offline" }))).toBe("offline");
  });

  it("shares clear-bed and print eligibility rules across printer surfaces", () => {
    expect(printerNeedsClearBed(printer({ state: "awaiting_bed_clear" }))).toBe(true);
    expect(printerNeedsClearBed(printer({ state: "operational", job: "done.gcode" }))).toBe(true);
    expect(printerCanStartPrint(printer({ state: "idle" }))).toBe(true);
    expect(printerCanStartPrint(printer({ state: "operational", job: "done.gcode" }))).toBe(false);
    expect(printerCanStartPrint(printer({ state: "idle", is_out_of_order: true }))).toBe(false);
  });

  it("formats short and absolute finish times", () => {
    expect(formatEtaShort(45)).toBe("45хв");
    expect(formatEtaShort(125)).toBe("2г 5хв");
    expect(formatFinishTime(45, new Date("2026-07-11T10:00:00"))).toBe("Сьогодні, 10:45");
    expect(formatFinishTime(1_440, new Date("2026-07-11T10:00:00"))).toBe("Завтра, 10:00");
  });

  it("keeps slot labels one-based in the UI", () => {
    expect(getSlotNumber({ slot_index: 0 })).toBe("1");
    expect(getSlotNumber({ slot_index: 3 })).toBe("4");
  });

  it("uses live U1 filament presentation even when persistent slots exist", () => {
    const persistentSlots = Array.from({ length: 4 }, (_, slot_index) => ({
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
    }));

    expect(printerCardUsesPersistentSlots(printer({ slots: persistentSlots }))).toBe(false);
    expect(printerCardUsesPersistentSlots(printer({ kind: "other", slots: persistentSlots }))).toBe(true);
  });

  it("only enables native Skip Objects for an active Bambu print", () => {
    expect(canSkipObject(printer({ kind: "bambu", state: "printing", moonraker_url: null }))).toBe(true);
    expect(canSkipObject(printer({ kind: "bambu", state: "paused", moonraker_url: null }))).toBe(false);
    expect(canSkipObject(printer({ kind: "snapmaker_u1", state: "printing" }))).toBe(false);
  });

  it("resolves known printer assets and leaves unknown models for a placeholder", () => {
    expect(printerCover(printer({ kind: "bambu", bambu_model: "A1 mini" }))).toBe("/printers/a1_mini.png");
    expect(printerCover(printer({ kind: "other", bambu_model: null }))).toBeNull();
  });
});
