import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GcodeFileMeta, Printer } from "@/lib/types";
import { AmsSlotPicker, autoMapSlots, printerMaterialSlots } from "./SendModal";

const printer = (overrides: Partial<Printer> = {}): Printer => ({
  id: 1,
  name: "P1S",
  kind: "bambu",
  moonraker_url: null,
  bambu_dev_id: "dev-1",
  bambu_dev_ip: null,
  bambu_model: "P1S",
  bambu_lan_mode: false,
  bambu_has_ams: true,
  is_active: true,
  is_out_of_order: false,
  sort_order: 0,
  group_id: null,
  group_name: null,
  loaded_filaments: [
    { slot: 0, color: "#ff0000", color_name: "Red", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: 0, verified: true },
    { slot: 1, color: "#0000ff", color_name: "Blue", type: "PETG", brand: null, filament_id: null, empty: false, unit_id: 0, verified: true },
    { slot: 254, color: "#00ff00", color_name: "Green", type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null, verified: true },
  ],
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
  active_tray: 254,
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

describe("SendModal Bambu mapping", () => {
  it("offers every confirmed AMS tray even while the external spool is active", () => {
    expect(printerMaterialSlots(printer()).map((slot) => slot.slot)).toEqual([0, 1, 254]);
  });

  it("maps the file against the actual AMS instead of the currently active source", () => {
    const meta = {
      colors: ["#0000ff"],
      types: ["PETG"],
      used_g: [20],
    } as GcodeFileMeta;

    expect(autoMapSlots(meta, printer())).toEqual({ 0: 1 });
  });

  it("renders AMS trays as Handy-style filament reels", () => {
    const markup = renderToStaticMarkup(createElement(AmsSlotPicker, {
      allSlots: [
        { slot: 0, type: "PLA", color: "#ff0000", unit: 0, isEmpty: false, isExternal: false },
        { slot: 1, type: null, color: null, unit: 0, isEmpty: true, isExternal: false },
        { slot: 254, type: "PETG", color: "#00ff00", unit: null, isEmpty: false, isExternal: true },
      ],
      selectedSlot: 0,
      onSelect: () => {},
    }));

    expect(markup).toContain("AMS-A");
    expect(markup).toContain("A1");
    expect(markup).toContain("Порожньо");
    expect(markup).toContain("Зовнішня котушка");
    expect(markup).toContain('data-spool-reel="true"');
  });
});
