"use client";

import type { Filament } from "@/lib/types";

export type LabelTemplate = "standard" | "compact" | "thermal_62mm";

export const LABEL_DIMS: Record<LabelTemplate, { w: number; h: number; label: string }> = {
  standard:     { w: 340, h: 216, label: "85×54 мм (візитка)" },
  compact:      { w: 160, h: 80,  label: "40×20 мм (компакт)" },
  thermal_62mm: { w: 248, h: 116, label: "62×29 мм (термо)" },
};

const FULL_G = 1000;

function barColor(pct: number): string {
  if (pct < 20) return "#f97316";
  if (pct < 40) return "#eab308";
  return "#3b82f6";
}

export function LabelPreview({
  filament,
  template,
  qrBase64,
}: {
  filament: Filament;
  template: LabelTemplate;
  qrBase64?: string | null;
}) {
  const { w, h } = LABEL_DIMS[template];
  const pct = Math.min(100, Math.round((filament.grams_remaining / FULL_G) * 100));
  const fill = barColor(pct);

  if (template === "compact") {
    return (
      <svg
        id="label-preview-svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}
      >
        {filament.hex_color && (
          <rect x={0} y={0} width={22} height={h} fill={filament.hex_color} />
        )}
        <text x={27} y={22} fontSize={11} fontWeight="bold" fill="#111" fontFamily="system-ui">
          {filament.color.slice(0, 13)}
        </text>
        <text x={27} y={36} fontSize={9} fill="#555" fontFamily="system-ui">
          {filament.material}
        </text>
        <text x={27} y={52} fontSize={9} fill="#555" fontFamily="system-ui">
          {pct}% · {filament.grams_remaining}g
        </text>
        {filament.sku && (
          <text x={27} y={68} fontSize={7.5} fill="#9ca3af" fontFamily="monospace">
            {filament.sku}
          </text>
        )}
      </svg>
    );
  }

  const qrSize = template === "thermal_62mm" ? h * 0.78 : h * 0.70;
  const qrX = 10;
  const qrY = (h - qrSize) / 2;
  const tx = qrX + qrSize + 10;
  const tw = w - tx - 10;
  const isStd = template === "standard";

  return (
    <svg
      id="label-preview-svg"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", display: "block" }}
    >
      {/* QR code */}
      {qrBase64 ? (
        <image href={qrBase64} x={qrX} y={qrY} width={qrSize} height={qrSize} />
      ) : (
        <>
          <rect x={qrX} y={qrY} width={qrSize} height={qrSize} fill="#f3f4f6" rx={4} />
          <text
            x={qrX + qrSize / 2}
            y={qrY + qrSize / 2 + 4}
            fontSize={9}
            fill="#9ca3af"
            textAnchor="middle"
            fontFamily="system-ui"
          >
            QR
          </text>
        </>
      )}

      {/* color swatch */}
      {filament.hex_color && (
        <rect x={tx} y={9} width={18} height={18} fill={filament.hex_color} rx={3} />
      )}

      {/* color name */}
      <text
        x={filament.hex_color ? tx + 24 : tx}
        y={isStd ? 23 : 21}
        fontSize={isStd ? 14 : 11}
        fontWeight="bold"
        fill="#111"
        fontFamily="system-ui"
      >
        {filament.color.slice(0, 18)}
      </text>

      {/* brand · material */}
      <text x={tx} y={isStd ? 38 : 34} fontSize={isStd ? 10 : 9} fill="#555" fontFamily="system-ui">
        {[filament.brand, filament.material].filter(Boolean).join(" · ").slice(0, 24)}
      </text>

      {/* SKU */}
      {filament.sku && (
        <text x={tx} y={h - 14} fontSize={isStd ? 8 : 7} fill="#9ca3af" fontFamily="monospace">
          {filament.sku}
        </text>
      )}

      {/* progress bar background */}
      <rect x={tx} y={h - 10} width={tw} height={7} fill="#e5e7eb" rx={3} />
      {pct > 0 && (
        <rect x={tx} y={h - 10} width={(tw * pct) / 100} height={7} fill={fill} rx={3} />
      )}

      {/* pct label */}
      <text x={w - 10} y={h - 10 - 3} fontSize={isStd ? 8 : 7} fill="#6b7280" textAnchor="end" fontFamily="system-ui">
        {pct}% · {filament.grams_remaining} / {FULL_G}g
      </text>
    </svg>
  );
}
