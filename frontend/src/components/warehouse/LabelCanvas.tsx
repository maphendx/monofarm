"use client";

/**
 * LabelCanvas — renders a label template with real or sample data.
 * Used in: template editor preview, WarehouseLabelModal, A4 print capture.
 *
 * All coordinates/sizes in mm. For screen display, wrap in a scaled container.
 */

import { useLayoutEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ElementType = "text" | "qr" | "barcode" | "image" | "rect" | "line";

export interface LabelElement {
  id: string;
  type: ElementType;
  x: number; y: number; w: number; h: number;

  // text
  text?: string;
  fontSize?: number;         // mm
  fontWeight?: "normal" | "bold";
  color?: string;
  align?: "left" | "center" | "right";

  // qr / barcode
  value?: string;
  barcodeFormat?: "CODE128" | "EAN13";
  showText?: boolean;
  level?: "L" | "M" | "Q" | "H";

  // image
  source?: "product_image";
  objectFit?: "cover" | "contain";

  // rect
  borderColor?: string;
  borderWidth?: number;
  fillColor?: string;
  borderRadius?: number;

  // line
  strokeColor?: string;
  strokeWidth?: number;
  orientation?: "horizontal" | "vertical";
}

export interface LabelTemplate {
  id: number;
  name: string;
  item_type: string;   // "cell" | "product" | "action" | "universal"
  width_mm: number;
  height_mm: number;
  elements: LabelElement[];
  is_builtin?: boolean;
  is_default?: boolean;
}

export interface LabelDataVars {
  // cell
  code?: string;
  zone_name?: string;
  notes?: string;
  CELL_QR?: string;
  // product
  name?: string;
  sku?: string;
  barcode?: string;
  categories?: string;
  PROD_QR?: string;
  product_image?: string;   // data URL or absolute URL
  price?: string;           // formatted sale price (no currency)
  cost?: string;            // formatted cost (no currency)
  currency?: string;        // e.g. "₴"
  // action
  label?: string;
  ACTION_QR?: string;
  [key: string]: string | undefined;
}

// ─── Variable substitution ───────────────────────────────────────────────────

export function substituteVars(tpl: string, vars: LabelDataVars): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

// ─── Auto-fit text ───────────────────────────────────────────────────────────
// Renders text that shrinks to fit its box: starts at the configured font size
// (treated as a max) and steps down until the content fits both width and height.
// Keeps labels readable for any box the user draws — never silently clips.

const MIN_FIT_MM = 1.2;

function AutoFitText({
  content, fontSize, fontWeight, color, align,
}: {
  content: string;
  fontSize: number;                    // mm — acts as the maximum
  fontWeight?: "normal" | "bold";
  color?: string;
  align?: "left" | "center" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(fontSize);

  // Reset to the configured size whenever inputs change; the layout effect
  // below then steps it down if the content overflows.
  useLayoutEffect(() => { setFit(fontSize); }, [content, fontSize]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // overflow:hidden means scrollHeight/Width reflect full (clipped) content.
    const overH = el.scrollHeight - el.clientHeight;
    const overW = el.scrollWidth - el.clientWidth;
    if (overH > 0.5 || overW > 0.5) {
      const ratio = Math.min(
        el.clientHeight / Math.max(1, el.scrollHeight),
        el.clientWidth / Math.max(1, el.scrollWidth),
      );
      const next = Math.max(MIN_FIT_MM, fit * ratio * 0.97);
      if (next < fit - 0.03) setFit(next);
    }
  });

  return (
    <div ref={ref} style={{
      width: "100%",
      height: "100%",
      overflow: "hidden",
      fontSize: `${fit}mm`,
      fontWeight: fontWeight ?? "normal",
      color: color ?? "#000",
      textAlign: align ?? "left",
      lineHeight: 1.15,
      fontFamily: "Arial, Helvetica, sans-serif",
      wordBreak: "break-word",
      overflowWrap: "break-word",
    }}>
      {content}
    </div>
  );
}

// ─── Element renderer ────────────────────────────────────────────────────────

function ElementRenderer({
  el, vars, barcodeUrls, zplDpi,
}: {
  el: LabelElement;
  vars: LabelDataVars;
  barcodeUrls?: Record<string, string>;
  zplDpi?: number;
}) {
  const pos: React.CSSProperties = {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  };

  switch (el.type) {
    case "text": {
      const content = substituteVars(el.text ?? "", vars);
      return (
        <AutoFitText
          content={content}
          fontSize={el.fontSize ?? 4}
          fontWeight={el.fontWeight}
          color={el.color}
          align={el.align}
        />
      );
    }

    case "qr": {
      const qrVal = substituteVars(el.value ?? "", vars) || " ";
      if (zplDpi) {
        // Mirror the ZPL ^BQ magnification cap so the canvas matches the print output.
        // ^BQ mag is 1–10; at mag=10 and 300 DPI → max QR = 10×21 dots = 17.8 mm.
        const boxDots = Math.min(
          Math.floor(el.w * zplDpi / 25.4),
          Math.floor(el.h * zplDpi / 25.4),
        );
        const mag   = Math.min(10, Math.max(1, Math.floor(boxDots / 21)));
        const qrMm  = mag * 21 * 25.4 / zplDpi;
        const offX  = Math.max(0, (el.w - qrMm) / 2);
        const offY  = Math.max(0, (el.h - qrMm) / 2);
        return (
          <div style={{ ...pos, position: "relative" }}>
            <QRCode value={qrVal} level={el.level ?? "M"} size={128}
              style={{ position: "absolute", left: `${offX}mm`, top: `${offY}mm`, width: `${qrMm}mm`, height: `${qrMm}mm`, display: "block" }} />
          </div>
        );
      }
      return (
        <div style={pos}>
          <QRCode value={qrVal} level={el.level ?? "M"} size={128}
            style={{ width: "100%", height: "100%", display: "block" }} />
        </div>
      );
    }

    case "barcode": {
      const bcVal = substituteVars(el.value ?? "", vars);
      // key includes showText so toggle re-generates
      const cacheKey = `${bcVal}__${el.showText ? "1" : "0"}`;
      const bcUrl = barcodeUrls?.[cacheKey] ?? barcodeUrls?.[bcVal];
      return (
        <div style={{ ...pos, overflow: "hidden" }}>
          {bcUrl
            ? <img
                src={bcUrl}
                alt={bcVal}
                style={{
                  width: "100%",
                  height: "100%",
                  // SVG barcodes scale perfectly with objectFit: fill (bars stay rectangular)
                  objectFit: "fill",
                  display: "block",
                  imageRendering: "crisp-edges",
                }}
              />
            : <div style={{ width: "100%", height: "100%", background: "#f5f5f5", display: "flex", alignItems: "center", justifyContent: "center", border: "0.2mm dashed #ccc" }}>
                <span style={{ fontSize: `${Math.max(2, el.h * 0.14)}mm`, color: "#bbb", fontFamily: "Arial" }}>{bcVal || "штрих-код"}</span>
              </div>
          }
        </div>
      );
    }

    case "image": {
      const imgUrl = vars.product_image;
      return (
        <div style={{
          ...pos,
          borderRadius: `${el.borderRadius ?? 0.5}mm`,
          overflow: "hidden",
          background: "#f5f5f5",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {imgUrl
            ? <img src={imgUrl} alt="" style={{ width: "100%", height: "100%", objectFit: el.objectFit ?? "cover", display: "block" }} />
            : <span style={{ fontSize: `${Math.max(2, el.h * 0.2)}mm`, color: "#ccc", fontFamily: "Arial" }}>фото</span>
          }
        </div>
      );
    }

    case "rect": {
      return (
        <div style={{
          ...pos,
          border: `${el.borderWidth ?? 0.3}mm solid ${el.borderColor ?? "#ccc"}`,
          borderRadius: `${el.borderRadius ?? 0}mm`,
          background: el.fillColor ?? "transparent",
        }} />
      );
    }

    case "line": {
      const isV = el.orientation === "vertical";
      const sw = el.strokeWidth ?? 0.3;
      return (
        <div style={{
          ...pos,
          background: el.strokeColor ?? "#ccc",
          width:  isV ? `${sw}mm` : `${el.w}mm`,
          height: isV ? `${el.h}mm` : `${sw}mm`,
        }} />
      );
    }

    default:
      return null;
  }
}

// ─── LabelCanvas ─────────────────────────────────────────────────────────────

export function LabelCanvas({
  template,
  vars,
  barcodeUrls,
  selected,
  onSelect,
  noBorder,
  zplDpi,
}: {
  template: LabelTemplate;
  vars: LabelDataVars;
  barcodeUrls?: Record<string, string>;
  selected?: string;
  onSelect?: (id: string) => void;
  /** Pass true in editor to remove the border — it shifts absolute positions */
  noBorder?: boolean;
  /** When set, QR elements are rendered at the actual ZPL-limited size (mag 1–10 cap) */
  zplDpi?: number;
}) {
  return (
    <div style={{
      position: "relative",
      width: `${template.width_mm}mm`,
      height: `${template.height_mm}mm`,
      background: "#fff",
      border: noBorder ? "none" : "0.3mm solid #ccc",
      borderRadius: noBorder ? "0" : "1mm",
      overflow: "hidden",
      fontFamily: "Arial, Helvetica, sans-serif",
    }}>
      {template.elements.map(el => (
        <div
          key={el.id}
          onClick={onSelect ? () => onSelect(el.id) : undefined}
          style={{
            position: "absolute",
            left: `${el.x}mm`, top: `${el.y}mm`,
            width: `${el.w}mm`, height: `${el.h}mm`,
            outline: selected === el.id ? "0.5mm solid #06b6d4" : "none",
            cursor: onSelect ? "pointer" : "default",
            boxSizing: "border-box",
          }}
        >
          <ElementRenderer el={el} vars={vars} barcodeUrls={barcodeUrls} zplDpi={zplDpi} />
        </div>
      ))}
    </div>
  );
}
