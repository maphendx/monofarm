"use client";

/**
 * LabelCanvas — renders a label template with real or sample data.
 * Used in: template editor preview, WarehouseLabelModal, A4 print capture.
 *
 * All coordinates/sizes in mm. For screen display, wrap in a scaled container.
 */

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
  // action
  label?: string;
  ACTION_QR?: string;
  [key: string]: string | undefined;
}

// ─── Variable substitution ───────────────────────────────────────────────────

export function substituteVars(tpl: string, vars: LabelDataVars): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

// ─── Element renderer ────────────────────────────────────────────────────────

function ElementRenderer({
  el, vars, barcodeUrls,
}: {
  el: LabelElement;
  vars: LabelDataVars;
  barcodeUrls?: Record<string, string>;
}) {
  const pos: React.CSSProperties = {
    position: "absolute",
    left: `${el.x}mm`, top: `${el.y}mm`,
    width: `${el.w}mm`, height: `${el.h}mm`,
    overflow: "hidden",
  };

  switch (el.type) {
    case "text": {
      const content = substituteVars(el.text ?? "", vars);
      return (
        <div style={{
          ...pos,
          fontSize: `${el.fontSize ?? 4}mm`,
          fontWeight: el.fontWeight ?? "normal",
          color: el.color ?? "#000",
          textAlign: el.align ?? "left",
          lineHeight: 1.2,
          display: "block",
          fontFamily: "Arial, Helvetica, sans-serif",
          wordBreak: "break-word",
          overflowWrap: "break-word",
        }}>
          {content}
        </div>
      );
    }

    case "qr": {
      const qrVal = substituteVars(el.value ?? "", vars) || " ";
      return (
        <div style={pos}>
          <QRCode value={qrVal} level={el.level ?? "M"} size={128}
            style={{ width: "100%", height: "100%", display: "block" }} />
        </div>
      );
    }

    case "barcode": {
      const bcVal = substituteVars(el.value ?? "", vars);
      const bcUrl = barcodeUrls?.[bcVal];
      return (
        <div style={{ ...pos }}>
          {bcUrl
            ? <img src={bcUrl} alt={bcVal} style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }} />
            : <div style={{ width: "100%", height: "100%", background: "#f5f5f5", display: "flex", alignItems: "center", justifyContent: "center" }}>
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
}: {
  template: LabelTemplate;
  vars: LabelDataVars;
  barcodeUrls?: Record<string, string>;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <div style={{
      position: "relative",
      width: `${template.width_mm}mm`,
      height: `${template.height_mm}mm`,
      background: "#fff",
      border: "0.3mm solid #ccc",
      borderRadius: "1mm",
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
          <ElementRenderer el={el} vars={vars} barcodeUrls={barcodeUrls} />
        </div>
      ))}
    </div>
  );
}
