export async function generateCode128Url(text: string, hPx: number): Promise<string | null> {
  if (!text) return null;
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (
      el: HTMLCanvasElement, v: string, o: object,
    ) => void;
    const canvas = document.createElement("canvas");
    // Generate at 2× resolution. Keep bars shorter so image isn't portrait-heavy.
    const h = Math.round(hPx * 2);
    const barH = Math.round(h * 0.52);
    const fontSize = Math.max(10, Math.round(h * 0.13));
    JsBarcode(canvas, text, {
      format: "CODE128", displayValue: true,
      fontSize, textMargin: 2, margin: 4,
      width: 2, height: barH,
      background: "#ffffff", lineColor: "#000000",
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
