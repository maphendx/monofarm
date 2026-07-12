import { describe, expect, it } from "bun:test";

import {
  dismissPrintTransfer,
  getPrintTransfers,
  trackPrintTransfer,
} from "./printTransferStore";

describe("print transfer store", () => {
  it("keeps a queued print visible after the send modal closes", () => {
    trackPrintTransfer({ jobId: 701, printerId: 4, printerName: "A1 mini", fileName: "large.3mf" });

    expect(getPrintTransfers()).toEqual([
      expect.objectContaining({
        jobId: 701,
        printerName: "A1 mini",
        fileName: "large.3mf",
        status: "queued",
      }),
    ]);

    dismissPrintTransfer(701);
    expect(getPrintTransfers()).toEqual([]);
  });

  it("persists active transfers so a page reload can restore them", () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: (_key: string, value: string) => writes.push(value) },
    });

    trackPrintTransfer({ jobId: 702, printerId: 5, printerName: "P1S", fileName: "big.3mf" });

    expect(JSON.parse(writes.at(-1) ?? "[]")).toEqual([
      expect.objectContaining({ jobId: 702, status: "queued" }),
    ]);
    dismissPrintTransfer(702);
    Reflect.deleteProperty(globalThis, "localStorage");
  });
});
