export async function generateCode128Url(text: string, hPx: number): Promise<string | null> {
  if (!text) return null;
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (
      el: HTMLCanvasElement, v: string, o: object,
    ) => void;
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, text, {
      format: "CODE128", displayValue: true,
      fontSize: Math.max(8, Math.round(hPx * 0.18)),
      textMargin: 2, margin: 4,
      width: 2, height: Math.round(hPx * 0.62),
      background: "#ffffff", lineColor: "#000000",
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
