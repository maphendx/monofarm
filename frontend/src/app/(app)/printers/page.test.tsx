import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocaleProvider } from "@/lib/i18n";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));

const { AddPrinterWizard } = await import("./page");

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
});
