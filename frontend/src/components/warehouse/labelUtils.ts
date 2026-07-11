import { EAN13_SVG_RENDER_OPTIONS, EAN13_SVG_SIZE } from "@/lib/ean13";

/**
 * Generates a Code128 barcode as an SVG data URL.
 * SVG is infinitely scalable — no pixelation at any element size.
 * hPx is kept for API compatibility but no longer affects quality.
 */
export async function generateCode128Url(
  text: string,
  _hPx?: number,
  showText = false,
): Promise<string | null> {
  if (!text) return null;
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (
      el: SVGSVGElement | HTMLCanvasElement, v: string, o: object,
    ) => void;

    // Render into an SVG element (vector, infinitely scalable)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(svg as unknown as SVGSVGElement, text, {
      format: "CODE128",
      displayValue: showText,
      fontSize: showText ? 14 : 0,
      textMargin: showText ? 4 : 0,
      margin: 2,
      background: "#ffffff",
      lineColor: "#000000",
      xmlDocument: document,
    });

    // Serialize SVG → data URL
    const serialized = new XMLSerializer().serializeToString(svg);
    const encoded = encodeURIComponent(serialized);
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
  } catch {
    return null;
  }
}

/** Generates a raw EAN-13 SVG for vector previews and clipboard export. */
export async function generateEan13Svg(text: string): Promise<string | null> {
  if (!/^\d{13}$/.test(text)) return null;
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (
      el: SVGSVGElement, v: string, o: object,
    ) => void;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(svg, text, {
      format: "EAN13",
      displayValue: true,
      ...EAN13_SVG_RENDER_OPTIONS,
      background: "#ffffff",
      lineColor: "#000000",
      xmlDocument: document,
    });
    const groups = svg.querySelectorAll("g");
    const leadingText = svg.querySelector("text");
    const firstBarsTransform = groups[1]?.getAttribute("transform") ?? "";
    const firstBarsX = Number(/translate\(([-\d.]+)/.exec(firstBarsTransform)?.[1]);
    if (leadingText && Number.isFinite(firstBarsX)) {
      const digitWidth = EAN13_SVG_RENDER_OPTIONS.fontSize * 0.62;
      leadingText.setAttribute("x", String(Math.max(0, firstBarsX - digitWidth - 1)));
    }
    svg.setAttribute("width", `${EAN13_SVG_SIZE.width}px`);
    svg.setAttribute("height", `${EAN13_SVG_SIZE.height}px`);
    svg.setAttribute("preserveAspectRatio", "none");
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
}
