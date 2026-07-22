import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocaleProvider } from "@/lib/i18n";
import type { Printer } from "@/lib/types";
import { AddPrinterWizard, PrinterEditModal } from "./PrintersManager";
import {
  buildAnycubicCreateBody,
  buildAnycubicUpdateFields,
  runSingleSubmission,
} from "./printerWizardModel";

describe("Anycubic add-printer flow", () => {
  it("shows Anycubic in the active add-printer wizard", () => {
    const markup = renderToStaticMarkup(createElement(
      LocaleProvider,
      null,
      createElement(AddPrinterWizard, {
        open: true,
        onClose: () => {},
        onDone: () => {},
      }),
    ));

    expect(markup).toContain("Anycubic Kobra");
  });

  it("builds the API payload with the trimmed LAN address", () => {
    expect(buildAnycubicCreateBody(" Kobra 3 Max ", " 192.168.31.67 ")).toEqual({
      name: "Kobra 3 Max",
      kind: "anycubic",
      anycubic_dev_ip: "192.168.31.67",
    });
  });

  it("allows only one unresolved create request", async () => {
    const lock = { current: false };
    let release!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });

    const first = runSingleSubmission(lock, async () => { calls += 1; await pending; });
    const second = runSingleSubmission(lock, async () => { calls += 1; });

    expect(await second).toBe(false);
    expect(calls).toBe(1);
    release();
    expect(await first).toBe(true);
  });

  it("hydrates and saves the Anycubic LAN address in the edit flow", () => {
    const printer = {
      id: 124,
      name: "Anycubic Kobra 3 Max",
      kind: "anycubic",
      anycubic_dev_ip: "192.168.31.67",
      is_active: true,
    } as Printer;
    const markup = renderToStaticMarkup(createElement(
      LocaleProvider,
      null,
      createElement(PrinterEditModal, {
        open: true,
        onClose: () => {},
        onDone: () => {},
        printer,
      }),
    ));

    expect(markup).toContain('value="192.168.31.67"');
    expect(markup).toContain('type="button" disabled=""');
    expect(buildAnycubicUpdateFields("anycubic", " 192.168.31.68 ")).toEqual({
      anycubic_dev_ip: "192.168.31.68",
    });
    expect(buildAnycubicUpdateFields("bambu", "192.168.31.68")).toEqual({});
  });
});
