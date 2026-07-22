import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AddPrinterWizard } from "./PrintersManager";
import { buildAnycubicCreateBody } from "./printerWizardModel";

describe("Anycubic add-printer flow", () => {
  it("shows Anycubic in the active add-printer wizard", () => {
    const markup = renderToStaticMarkup(createElement(AddPrinterWizard, {
      open: true,
      onClose: () => {},
      onDone: () => {},
    }));

    expect(markup).toContain("Anycubic Kobra");
  });

  it("builds the API payload with the trimmed LAN address", () => {
    expect(buildAnycubicCreateBody(" Kobra 3 Max ", " 192.168.31.67 ")).toEqual({
      name: "Kobra 3 Max",
      kind: "anycubic",
      anycubic_dev_ip: "192.168.31.67",
    });
  });
});
