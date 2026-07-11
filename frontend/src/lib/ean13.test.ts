import { describe, expect, test } from "bun:test";

import {
  EAN13_SVG_RENDER_OPTIONS,
  EAN13_SVG_SIZE,
  generateEan13,
  getEan13Value,
  isValidEan13,
} from "./ean13";

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

  test("returns the finished EAN for both source codes and existing EANs", () => {
    expect(getEan13Value("03026100")).toBe("4820030261006");
    expect(getEan13Value("4820030261006")).toBe("4820030261006");
    expect(getEan13Value("CODE-128")).toBeNull();
  });

  test("uses the requested fixed SVG dimensions", () => {
    expect(EAN13_SVG_SIZE).toEqual({ width: 230, height: 100 });
    expect(EAN13_SVG_RENDER_OPTIONS.margin).toBe(0);
    expect(EAN13_SVG_RENDER_OPTIONS.textMargin).toBe(0);
  });
});
