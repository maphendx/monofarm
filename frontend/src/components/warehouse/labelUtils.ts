export async function generateCode128Url(text: string, hPx: number): Promise<string | null> {
  if (!text) return null;
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (
      el: HTMLCanvasElement, v: string, o: object,
    ) => void;
    const canvas = document.createElement("canvas");
    // Generate at 3× resolution for crisp display at any scale
    const h = Math.round(hPx * 3);
    JsBarcode(canvas, text, {
      format: "CODE128", displayValue: true,
      fontSize: Math.max(14, Math.round(h * 0.14)),
      textMargin: 3, margin: 6,
      width: 3, height: Math.round(h * 0.62),
      background: "#ffffff", lineColor: "#000000",
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
