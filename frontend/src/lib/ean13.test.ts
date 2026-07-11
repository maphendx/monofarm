import { describe, expect, test } from "bun:test";

import { generateEan13, isValidEan13 } from "./ean13";

describe("generateEan13", () => {
  test("builds a Ukrainian EAN-13 from an eight-digit product code", () => {
    expect(generateEan13("03026100")).toBe("4820030261006");
  });

  test("ignores formatting spaces in the product code", () => {
    expect(generateEan13("03 026 100")).toBe("4820030261006");
  });

  test("returns null when the product code is not eight digits", () => {
    expect(generateEan13("1234567")).toBeNull();
    expect(generateEan13("123456789")).toBeNull();
    expect(generateEan13("ABC12345")).toBeNull();
  });

  test("recognizes a valid generated EAN-13", () => {
    expect(isValidEan13("4820030261006")).toBe(true);
    expect(isValidEan13("4820030261007")).toBe(false);
  });
});
