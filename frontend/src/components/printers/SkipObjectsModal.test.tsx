import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkipObjectsContent, selectableSkipCount } from "./SkipObjectsModal";
import { LocaleProvider } from "@/lib/i18n";

const objects = [
  { id: "cube-a", name: "Cube", excluded: false, current: true, bounds: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number] },
  { id: "cube-b", name: "Cube · 2", excluded: false, current: false, bounds: [0.55, 0.5, 0.72, 0.7] as [number, number, number, number] },
];

describe("SkipObjectsModal", () => {
  it("renders a selectable live bed map and object list", () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, null, createElement(SkipObjectsContent, {
      printerName: "U1",
      objects,
      selectedIds: new Set(["cube-b"]),
      onToggle: () => {},
      loading: false,
      unavailableReason: null,
    })));

    expect(markup).toContain('data-skip-bed="true"');
    expect(markup).toContain('data-object-id="cube-b"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("Cube · 2");
    expect(markup).toContain("Друкується зараз");
  });

  it("never allows selecting every remaining object", () => {
    expect(selectableSkipCount(objects)).toBe(1);
  });

  it("explains when the file has no labeled objects", () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, null, createElement(SkipObjectsContent, {
      printerName: "U1",
      objects: [],
      selectedIds: new Set(),
      onToggle: () => {},
      loading: false,
      unavailableReason: "missing_object_labels",
    })));

    expect(markup).toContain("Label objects");
    expect(markup).toContain("Exclude objects");
  });
});
