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
});
