import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PrinterAmsOverview } from "./PrinterAmsOverview";

describe("PrinterAmsOverview", () => {
  it("renders printer-page AMS slots in the Bambu Handy visual language", () => {
    const markup = renderToStaticMarkup(createElement(PrinterAmsOverview, {
      groups: [
        {
          title: null,
          external: false,
          slots: [
            { key: "0-0", label: 1, empty: false, hex: "#22C55E", colorName: "Green", material: "PLA", brand: "Bambu", grams: 780, active: true, rawSlot: 0, verified: true },
            { key: "0-empty1", label: 2, empty: true, hex: "#888888", colorName: null, material: null, brand: null, grams: null, active: false, rawSlot: 1, verified: true },
          ],
        },
        {
          title: null,
          external: true,
          slots: [
            { key: "ext", label: 1, empty: false, hex: "#F97316", colorName: "Orange", material: "PETG", brand: null, grams: null, active: false, rawSlot: 254, verified: true },
          ],
        },
      ],
      onSlotClick: () => {},
    }));

    expect(markup).toContain('data-printer-ams="handy"');
    expect(markup).toContain("AMS-A");
    expect(markup).toContain("A1");
    expect(markup).toContain("Порожньо");
    expect(markup).toContain("Зовнішня котушка");
    expect(markup).toContain('data-spool-reel="true"');
    expect(markup).toContain('data-active="true"');
  });
});
