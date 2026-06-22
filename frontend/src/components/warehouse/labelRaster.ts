/**
 * labelRaster — turns a rendered label DOM node into a Zebra ^GFA graphic.
 *
 * Why: ZPL's scalable fonts and barcode commands never match the HTML editor
 * exactly (different metrics, no true bold, different wrapping). Instead of
 * approximating, we capture the *exact* rendered label — text with auto-fit and
 * bold, barcode, QR, rect/line — into a 1-bit bitmap and send it as a graphic.
 * The printout then matches the on-screen preview pixel-for-pixel.
 *
 * The node is serialized into an SVG <foreignObject>, drawn to a canvas at the
 * printer's DPI, thresholded to monochrome, and hex-encoded as ^GFA. All inner
 * resources (barcode/QR) are inline data-URL SVGs, so the canvas is never
 * tainted and getImageData works.
 */

const CSS_DPI = 96; // CSS reference: 1in = 96px, so 1mm = 96/25.4 px

// Pack a canvas into a 1-bit-per-pixel ^GFA payload (1 = black, MSB first).
function canvasToGfa(ctx: CanvasRenderingContext2D, w: number, h: number): {
  hex: string;
  total: number;
  rowBytes: number;
} {
  const data = ctx.getImageData(0, 0, w, h).data;
  const rowBytes = Math.ceil(w / 8);
  const bytes = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      // Transparent → white; otherwise luminance threshold at mid-grey.
      const lum = a < 128 ? 255 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 128) bytes[rowOff + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const H = "0123456789ABCDEF";
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += H[bytes[i] >> 4] + H[bytes[i] & 15];
  return { hex, total: bytes.length, rowBytes };
}

/**
 * Render a label node to a single ^XA…^XZ block containing a ^GFA graphic.
 * @param node    the rendered LabelCanvas root element (sized in mm)
 * @param wMm/hMm the label dimensions in millimetres
 * @param dpi     target printer resolution (203 / 300 / 600)
 */
export async function labelNodeToGfaZpl(
  node: HTMLElement,
  wMm: number,
  hMm: number,
  dpi: number,
): Promise<string> {
  const wPx = Math.max(1, Math.round((wMm * dpi) / 25.4));
  const hPx = Math.max(1, Math.round((hMm * dpi) / 25.4));
  const naturalW = node.offsetWidth || (wMm * CSS_DPI) / 25.4;
  const naturalH = node.offsetHeight || (hMm * CSS_DPI) / 25.4;
  const scale = wPx / naturalW;

  const xml = new XMLSerializer().serializeToString(node);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wPx}" height="${hPx}">` +
    `<foreignObject x="0" y="0" width="${wPx}" height="${hPx}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${scale});transform-origin:top left;` +
    `width:${naturalW}px;height:${naturalH}px;background:#ffffff">` +
    xml +
    `</div></foreignObject></svg>`;

  const img = new Image();
  img.width = wPx;
  img.height = hPx;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("label raster image failed to load"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });

  const canvas = document.createElement("canvas");
  canvas.width = wPx;
  canvas.height = hPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get 2d canvas context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, wPx, hPx);
  ctx.drawImage(img, 0, 0, wPx, hPx);

  const { hex, total, rowBytes } = canvasToGfa(ctx, wPx, hPx);
  return [
    "^XA",
    `^PW${wPx}`,
    `^LL${hPx}`,
    "^LH0,0",
    `^FO0,0^GFA,${total},${total},${rowBytes},${hex}`,
    "^XZ",
  ].join("\n");
}
