import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocaleProvider } from "@/lib/i18n";
import type { Printer } from "@/lib/types";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));

const { AddPrinterWizard, PrinterModal } = await import("./page");

describe("printers page add flow", () => {
  it("shows Anycubic in the sidebar printers wizard", () => {
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

  it("shows the current Anycubic LAN address in the edit modal", () => {
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
      createElement(PrinterModal, {
        open: true,
        onClose: () => {},
        onDone: () => {},
        printer,
      }),
    ));

    expect(markup).toContain('value="192.168.31.67"');
  });
});
