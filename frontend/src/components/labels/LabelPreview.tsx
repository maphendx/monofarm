"use client";

import { useEffect, useState } from "react";
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
  barcode: true, colorName: false, brandMaterial: true, sku: true, progress: false, labelId: true,
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
    let cancelled = false;
    import("jsbarcode").then(mod => {
      if (cancelled) return;
      try {
        const JsBarcode = (mod as { default: Function }).default ?? mod;
        const canvas = document.createElement("canvas");
        (JsBarcode as Function)(canvas, text, {
          format: "CODE128",
          displayValue: false,
          margin: 8,
          width: 3,
          height: 72,
          background: "#ffffff",
          lineColor: "#000000",
        });
        if (!cancelled) setUrl(canvas.toDataURL("image/png"));
      } catch {
        if (!cancelled) setUrl(null);
      }
    }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
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
  const barcodeText = (labelId && labelId.length > 0) ? labelId : (filament.sku ?? String(filament.id));
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

  // ── compact ──────────────────────────────────────────────────────────────────
  if (template === "compact" || (template === "custom" && h < 100)) {
    return (
      <svg id="label-preview-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}
        style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}>
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
          <text x={27} y={Math.min(52, h * 0.7)} fontSize={9} fill="#111" fontFamily="monospace" fontWeight="bold">
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

  // ── standard / thermal / custom (larger) ────────────────────────────────────
  const showBarcode = fields.barcode && barcodeType !== "none";
  const code128Mode = barcodeType === "code128";

  // Code128 strip at the bottom
  const code128AreaH = code128Mode && showBarcode ? Math.min(60, h * 0.32) : 0;

  // QR on the left side
  const qrSize = !code128Mode && showBarcode ? h * (template === "thermal_62mm" ? 0.78 : 0.70) : 0;
  const qrX = 8;
  const qrY = showBarcode && !code128Mode ? (h - qrSize) / 2 : 0;

  // Text column starts after QR (or at left edge)
  const tx = !code128Mode && showBarcode ? qrX + qrSize + 8 : 10;
  const tw = w - tx - 8;

  const isStd = template === "standard" || (template === "custom" && h >= 180);
  const fsTitle = isStd ? 13 : 10;
  const fsSub   = isStd ? 9 : 8;
  const fsSmall = isStd ? 7.5 : 6.5;

  // Bottom boundary for text (above code128 strip)
  const textBottom = h - code128AreaH - 4;

  return (
    <svg id="label-preview-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}>

      {/* border */}
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke="#e5e7eb" strokeWidth={1} rx={2} />

      {/* QR code */}
      {!code128Mode && showBarcode && (
        qrBase64
          ? <image href={qrBase64} x={qrX} y={qrY} width={qrSize} height={qrSize} />
          : <>
              <rect x={qrX} y={qrY} width={qrSize} height={qrSize} fill="#f3f4f6" rx={3} />
              <text x={qrX + qrSize / 2} y={qrY + qrSize / 2 + 4} fontSize={8} fill="#9ca3af" textAnchor="middle" fontFamily="system-ui">QR</text>
            </>
      )}

      {/* color name */}
      {fields.colorName && (
        <text x={tx} y={isStd ? 21 : 20} fontSize={fsTitle} fontWeight="bold" fill="#111" fontFamily="system-ui">
          {filament.color.slice(0, 22)}
        </text>
      )}

      {/* brand · material */}
      {fields.brandMaterial && (
        <text x={tx} y={fields.colorName ? (isStd ? 35 : 31) : (isStd ? 21 : 20)}
          fontSize={fsSub} fill="#555" fontFamily="system-ui">
          {[filament.brand, filament.material].filter(Boolean).join(" · ").slice(0, 28)}
        </text>
      )}

      {/* label ID — big, prominent */}
      {fields.labelId && labelId && labelId.length > 0 && (
        <text
          x={tx}
          y={(() => {
            let base = 8;
            if (fields.colorName) base += isStd ? 30 : 24;
            if (fields.brandMaterial) base += isStd ? 20 : 16;
            return base + (isStd ? 20 : 16);
          })()}
          fontSize={isStd ? 22 : 16} fontWeight="bold" fill="#111" fontFamily="monospace" letterSpacing="4"
        >
          {labelId}
        </text>
      )}

      {/* SKU */}
      {fields.sku && filament.sku && (
        <text x={tx} y={textBottom - 8} fontSize={fsSmall} fill="#9ca3af" fontFamily="monospace">
          {filament.sku}
        </text>
      )}

      {/* progress bar */}
      {fields.progress && (
        <>
          <rect x={tx} y={textBottom - 6} width={tw} height={6} fill="#e5e7eb" rx={3} />
          {pct > 0 && <rect x={tx} y={textBottom - 6} width={tw * pct / 100} height={6} fill={fillColor(pct)} rx={3} />}
          <text x={tx + tw} y={textBottom - 10} fontSize={fsSmall} fill="#6b7280" textAnchor="end" fontFamily="system-ui">
            {pct}% · {filament.grams_remaining}/{FULL_G}g
          </text>
        </>
      )}

      {/* Code128 strip at bottom */}
      {code128Mode && showBarcode && (
        code128Url
          ? <image href={code128Url} x={10} y={h - code128AreaH} width={w - 20} height={code128AreaH - 2}
              preserveAspectRatio="xMidYMid meet" />
          : <rect x={10} y={h - code128AreaH} width={w - 20} height={code128AreaH - 2} fill="#f3f4f6" rx={2} />
      )}
    </svg>
  );
}
