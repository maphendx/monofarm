import { afterEach, describe, expect, it } from "bun:test";

import { clearToken, setToken } from "./api";
import { clearPrintTransfers, getPrintTransfers, trackPrintTransfer } from "./printTransferStore";
import { safeInternalRedirect } from "./safeInternalRedirect";

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

afterEach(() => {
  clearPrintTransfers();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("private browser state", () => {
  for (const action of ["logout", "new login"]) {
    it(`clears printer and transfer data on ${action}`, () => {
      const values = installStorage();
      values.set("monofarm_token", "old-token");
      values.set("printers_cache", "PRIVATE PRINTERS");
      values.set("monofarm_impersonation", "PRIVATE ORGANIZATION");
      trackPrintTransfer({ jobId: 900, printerId: 1, printerName: "Private printer", fileName: "Private part" });
      if (action === "logout") clearToken();
      else setToken("new-token");
      expect(getPrintTransfers()).toEqual([]);
      expect(values.has("printers_cache")).toBe(false);
      expect(values.has("monofarm_active_print_transfers")).toBe(false);
      expect(values.has("monofarm_impersonation")).toBe(false);
    });
  }
});

describe("webview redirects", () => {
  it("keeps a local slicer target", () => {
    expect(safeInternalRedirect("/dashboard?slicerFile=12&slicerAction=choose")).toBe("/dashboard?slicerFile=12&slicerAction=choose");
  });
  for (const value of ["javascript:alert(1)", "https://example.com", "//example.com", "/\\example.com", "/\n/example.com", null]) {
    it(`rejects an unsafe redirect ${JSON.stringify(value)}`, () => {
      expect(safeInternalRedirect(value)).toBe("/files");
    });
  }
});
