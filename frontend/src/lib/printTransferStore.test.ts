import { describe, expect, it } from "bun:test";

import {
  dismissPrintTransfer,
  getPrintTransferDismissKey,
  getPrintTransfers,
  PRINT_TRANSFER_DISMISS_MS,
  trackPrintTransfer,
  type PrintTransfer,
} from "./printTransferStore";

function makeTransfer(overrides: Partial<PrintTransfer> = {}): PrintTransfer {
  return {
    jobId: 703,
    printerId: 5,
    printerName: "P1S",
    fileName: "big.3mf",
    status: "uploading",
    statusReason: null,
    progressPct: 42,
    errorMessage: null,
    isActive: true,
    ...overrides,
  };
}

describe("print transfer store", () => {
  it("dismisses terminal transfer overlays within four seconds", () => {
    expect(PRINT_TRANSFER_DISMISS_MS).toBe(3500);
  });

  it("starts dismissing after the printer accepts the file or starts printing", () => {
    expect(getPrintTransferDismissKey([makeTransfer({ status: "uploading" })])).toBe("");
    expect(getPrintTransferDismissKey([makeTransfer({ status: "acknowledged" })])).toBe("703");
    expect(getPrintTransferDismissKey([makeTransfer({ status: "printing" })])).toBe("703");
  });

  it("does not restart the dismiss timer when print progress changes", () => {
    const atOnePercent = makeTransfer({ status: "printing", progressPct: 1 });
    const atSeventyPercent = makeTransfer({ status: "printing", progressPct: 70 });

    expect(getPrintTransferDismissKey([atOnePercent])).toBe(
      getPrintTransferDismissKey([atSeventyPercent]),
    );
  });

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
