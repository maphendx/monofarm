"use client";

import { useEffect, useState } from "react";
import JsBarcode from "jsbarcode";
import type { Filament } from "@/lib/types";

export type LabelTemplate = "standard" | "compact" | "thermal_62mm" | "custom";
export type BarcodeType = "qr" | "code128" | "none";

export const LABEL_DIMS: Record<Exclude<LabelTemplate, "custom">, { w: number; h: number; label: string }> = {
  standard:     { w: 340, h: 216, label: "85×54 мм (візитка)" },
  compact:      { w: 160, h: 80,  label: "40×20 мм (компакт)" },
  thermal_62mm: { w: 248, h: 116, label: "62×29 мм (термо)" },
};

export interface LabelFields {
  barcode: boolean;
  colorName: boolean;
  brandMaterial: boolean;
  sku: boolean;
  progress: boolean;
  labelId: boolean;
}

export const DEFAULT_FIELDS: LabelFields = {
  barcode: true, colorName: true, brandMaterial: true, sku: true, progress: false, labelId: true,
};

const FULL_G = 1000;
const MM_TO_PX = 4;

function fillColor(pct: number): string {
  if (pct < 20) return "#f97316";
  if (pct < 40) return "#eab308";
  return "#3b82f6";
}

function useCode128DataUrl(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) { setUrl(null); return; }
    try {
      const canvas = document.createElement("canvas");
      JsBarcode(canvas, text, {
        format: "CODE128", displayValue: false,
        margin: 4, width: 1.8, height: 36, background: "#ffffff",
      });
      setUrl(canvas.toDataURL("image/png"));
    } catch {
      setUrl(null);
    }
  }, [text]);
  return url;
}

export function LabelPreview({
  filament,
  template,
  barcodeType = "qr",
  qrBase64,
  labelId,
  customWmm,
  customHmm,
  fields = DEFAULT_FIELDS,
}: {
  filament: Filament;
  template: LabelTemplate;
  barcodeType?: BarcodeType;
  qrBase64?: string | null;
  labelId?: string | null;
  customWmm?: number;
  customHmm?: number;
  fields?: LabelFields;
}) {
  const pct = Math.min(100, Math.round((filament.grams_remaining / FULL_G) * 100));
  const barcodeText = labelId || filament.sku || String(filament.id);
  const code128Url = useCode128DataUrl(barcodeType === "code128" ? barcodeText : null);

  let w: number, h: number;
  if (template === "custom") {
    w = Math.max(80, (customWmm ?? 85) * MM_TO_PX);
    h = Math.max(40, (customHmm ?? 54) * MM_TO_PX);
  } else if (template === "compact") {
    w = LABEL_DIMS.compact.w;
    h = LABEL_DIMS.compact.h;
  } else {
    w = LABEL_DIMS[template].w;
    h = LABEL_DIMS[template].h;
  }

  if (template === "compact" || (template === "custom" && h < 100)) {
    return (
      <svg
        id="label-preview-svg"
        width={w} height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}
      >
        {filament.hex_color && fields.colorName && (
          <rect x={0} y={0} width={22} height={h} fill={filament.hex_color} />
        )}
        {fields.colorName && (
          <text x={27} y={Math.min(22, h * 0.3)} fontSize={11} fontWeight="bold" fill="#111" fontFamily="system-ui">
            {filament.color.slice(0, 13)}
          </text>
        )}
        {fields.brandMaterial && (
          <text x={27} y={Math.min(36, h * 0.5)} fontSize={9} fill="#555" fontFamily="system-ui">
            {filament.material}
          </text>
        )}
        {fields.labelId && labelId && (
          <text x={27} y={Math.min(52, h * 0.7)} fontSize={9} fill="#374151" fontFamily="monospace" fontWeight="bold">
            {labelId}
          </text>
        )}
        {fields.sku && filament.sku && (
          <text x={27} y={h - 8} fontSize={7.5} fill="#9ca3af" fontFamily="monospace">
            {filament.sku}
          </text>
        )}
      </svg>
    );
  }

  const showBarcode = fields.barcode && barcodeType !== "none";
  const barcodeH = h * (template === "thermal_62mm" ? 0.78 : 0.70);

  // For Code128, barcode is shown at the bottom spanning full width
  const code128Mode = barcodeType === "code128";
  const code128AreaH = code128Mode && showBarcode ? Math.min(50, h * 0.28) : 0;

  const qrSize = !code128Mode && showBarcode ? barcodeH : 0;
  const qrX = 10;
  const qrY = showBarcode && !code128Mode ? (h - qrSize) / 2 : 0;
  const tx = !code128Mode && showBarcode ? qrX + qrSize + 10 : 10;
  const tw = w - tx - 10;

  const isStd = template === "standard" || (template === "custom" && h >= 180);
  const fsTitle = isStd ? 14 : 11;
  const fsSub   = isStd ? 10 : 9;
  const fsSmall = isStd ? 8 : 7;

  const textAreaH = h - code128AreaH - 4;

  return (
    <svg
      id="label-preview-svg"
      width={w} height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}
    >
      {/* QR code */}
      {!code128Mode && showBarcode && (
        qrBase64
          ? <image href={qrBase64} x={qrX} y={qrY} width={qrSize} height={qrSize} />
          : <>
              <rect x={qrX} y={qrY} width={qrSize} height={qrSize} fill="#f3f4f6" rx={4} />
              <text x={qrX + qrSize / 2} y={qrY + qrSize / 2 + 4} fontSize={9} fill="#9ca3af" textAnchor="middle" fontFamily="system-ui">QR</text>
            </>
      )}

      {/* color swatch */}
      {fields.colorName && filament.hex_color && (
        <rect x={tx} y={9} width={18} height={18} fill={filament.hex_color} rx={3} />
      )}

      {/* color name */}
      {fields.colorName && (
        <text
          x={filament.hex_color ? tx + 24 : tx}
          y={isStd ? 23 : 21}
          fontSize={fsTitle} fontWeight="bold" fill="#111" fontFamily="system-ui"
        >
          {filament.color.slice(0, 20)}
        </text>
      )}

      {/* brand · material */}
      {fields.brandMaterial && (
        <text x={tx} y={isStd ? 38 : 34} fontSize={fsSub} fill="#555" fontFamily="system-ui">
          {[filament.brand, filament.material].filter(Boolean).join(" · ").slice(0, 26)}
        </text>
      )}

      {/* label ID */}
      {fields.labelId && labelId && (
        <text x={tx} y={isStd ? 56 : 48} fontSize={isStd ? 13 : 11} fontWeight="bold" fill="#111" fontFamily="monospace" letterSpacing="3">
          {labelId}
        </text>
      )}

      {/* SKU */}
      {fields.sku && filament.sku && (
        <text x={tx} y={textAreaH - 14} fontSize={fsSmall} fill="#9ca3af" fontFamily="monospace">
          {filament.sku}
        </text>
      )}

      {/* progress bar */}
      {fields.progress && (
        <>
          <rect x={tx} y={textAreaH - 10} width={tw} height={7} fill="#e5e7eb" rx={3} />
          {pct > 0 && <rect x={tx} y={textAreaH - 10} width={(tw * pct) / 100} height={7} fill={fillColor(pct)} rx={3} />}
          <text x={w - 10} y={textAreaH - 13} fontSize={fsSmall} fill="#6b7280" textAnchor="end" fontFamily="system-ui">
            {pct}% · {filament.grams_remaining}/{FULL_G}g
          </text>
        </>
      )}

      {/* Code128 barcode at bottom */}
      {code128Mode && showBarcode && (
        code128Url
          ? <image href={code128Url} x={10} y={h - code128AreaH - 2} width={w - 20} height={code128AreaH} preserveAspectRatio="none" />
          : <rect x={10} y={h - code128AreaH - 2} width={w - 20} height={code128AreaH} fill="#f3f4f6" rx={3} />
      )}
    </svg>
  );
}
