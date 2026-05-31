"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Modal } from "@/components/ui/Modal";
import { API_URL, getToken } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WarehouseLabelItem =
  | { type: "cell"; id: number; code: string; zone_name: string; notes?: string | null }
  | { type: "product"; id: number; name: string; sku: string; barcode?: string | null; image_url?: string | null; categories?: string[] };

type LabelSize   = "50x25" | "57x32" | "100x30" | "100x50" | "100x100";
type PrintMode   = "zebra" | "a4";
type LabelFields = { secondary: boolean; photo: boolean };

// ─── Constants ────────────────────────────────────────────────────────────────

const SIZES = [
  { key: "100x30"  as LabelSize, label: "100×30 мм",  wMm: 100, hMm: 30  },
  { key: "100x50"  as LabelSize, label: "100×50 мм",  wMm: 100, hMm: 50  },
  { key: "50x25"   as LabelSize, label: "50×25 мм",   wMm: 50,  hMm: 25  },
  { key: "57x32"   as LabelSize, label: "57×32 мм",   wMm: 57,  hMm: 32  },
  { key: "100x100" as LabelSize, label: "100×100 мм", wMm: 100, hMm: 100 },
];

const DEFAULT_SIZE: Record<PrintMode, LabelSize> = { a4: "100x30", zebra: "57x32" };
const DEFAULT_FIELDS: LabelFields = { secondary: true, photo: true };
const PX_PER_MM = 96 / 25.4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultQr(item: WarehouseLabelItem): string {
  return item.type === "cell" ? `CELL:${item.id}` : (item.barcode || item.sku);
}

async function fetchDataUrl(src: string): Promise<string | null> {
  if (src.startsWith("http")) return src;
  try {
    const r = await fetch(API_URL + src, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise<string>(res => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function generateCode128Url(text: string, hPx: number): Promise<string | null> {
  try {
    const mod = await import("jsbarcode");
    const JsBarcode = ((mod as { default?: unknown }).default ?? mod) as (el: HTMLCanvasElement, v: string, o: object) => void;
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, text, {
      format: "CODE128", displayValue: true,
      fontSize: Math.max(8, Math.round(hPx * 0.18)),
      textMargin: 2, margin: 4,
      width: 2, height: Math.round(hPx * 0.62),
      background: "#ffffff", lineColor: "#000000",
    });
    return canvas.toDataURL("image/png");
  } catch { return null; }
}

function buildZpl(
  items: WarehouseLabelItem[],
  qrVals: string[],
  sizeKey: LabelSize,
  fields: LabelFields,
): string {
  const cfg = SIZES.find(s => s.key === sizeKey)!;
  const d = (mm: number) => Math.round(mm * 203 / 25.4);
  const W = d(cfg.wMm), H = d(cfg.hMm), pad = d(2);
  const mag = Math.min(10, Math.max(2, Math.floor((H - pad * 2) / 21)));
  const qrD = mag * 21;
  const qrY = Math.floor((H - qrD) / 2);
  const txX = pad + qrD + pad;
  const fsP = Math.min(60, Math.floor(H * 0.30));
  const fsS = Math.min(36, Math.floor(H * 0.18));
  const safe = (s: string) => s.replace(/[\\^~]/g, "").slice(0, 28);

  return items.map((item, i) => {
    const primary   = item.type === "cell" ? item.code : safe(item.name);
    const secondary = item.type === "cell" ? item.zone_name : item.sku;
    const cats      = item.type === "product" ? (item.categories?.slice(0, 2).join(", ") ?? "") : "";

    return [
      "^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0",
      `^FO${pad},${qrY}^BQN,2,${mag}^FDMA,${safe(qrVals[i] ?? defaultQr(item))}^FS`,
      `^FO${txX},${Math.floor(H * 0.30)}^A0N,${fsP},${fsP}^FD${safe(primary)}^FS`,
      fields.secondary && secondary
        ? `^FO${txX},${Math.floor(H * 0.58)}^A0N,${fsS},${fsS}^FD${safe(secondary)}^FS` : "",
      cats ? `^FO${txX},${Math.floor(H * 0.78)}^A0N,${fsS},${fsS}^FD${safe(cats)}^FS` : "",
      "^XZ",
    ].filter(Boolean).join("\n");
  }).join("\n");
}

async function sendToBrowserPrint(zpl: string): Promise<"ok" | "not_available" | "error"> {
  try {
    const dr = await fetch("http://localhost:9090/default", { signal: AbortSignal.timeout(1200) });
    if (!dr.ok) return "not_available";
    const device = await dr.json() as Record<string, unknown>;
    const wr = await fetch("http://localhost:9090/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, data: zpl }),
      signal: AbortSignal.timeout(3000),
    });
    return wr.ok ? "ok" : "error";
  } catch { return "not_available"; }
}

// ─── LabelCard ────────────────────────────────────────────────────────────────
//
//  Cell:              [QR] | [code (big) + zone]
//  Product zebra:     [QR] | [name + sku]
//  Product a4:        [photo?] | [full name + categories] | [Code128 barcode]
//

function LabelCard({
  item, qrVal, cfg, fields, mode, imgDataUrl, barcodeDataUrl,
}: {
  item: WarehouseLabelItem;
  qrVal: string;
  cfg: (typeof SIZES)[number];
  fields: LabelFields;
  mode: PrintMode;
  imgDataUrl?: string;
  barcodeDataUrl?: string;
}) {
  const pad   = 1.5;
  const sqMm  = cfg.hMm - pad * 2;   // side-column square size (mm)

  const outer: React.CSSProperties = {
    width: `${cfg.wMm}mm`, height: `${cfg.hMm}mm`,
    border: "0.3mm solid #ccc", borderRadius: "1mm",
    display: "flex", flexDirection: "row", alignItems: "center",
    padding: `${pad}mm`, gap: `${pad}mm`,
    boxSizing: "border-box", background: "#fff", overflow: "hidden",
    fontFamily: "Arial, Helvetica, sans-serif",
  };

  const qrEl = (
    <div style={{ width: `${sqMm}mm`, height: `${sqMm}mm`, flexShrink: 0 }}>
      <QRCode value={qrVal || " "} level="M" size={128}
        style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );

  const fsPrimary = `${Math.max(3.5, cfg.hMm * 0.27)}mm`;
  const fsSub     = `${Math.max(2.2, cfg.hMm * 0.16)}mm`;
  const gap       = `${pad * 0.4}mm`;

  // ── Cell (QR left, text right) ──────────────────────────────────────────────
  if (item.type === "cell") {
    return (
      <div style={outer}>
        {qrEl}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", gap }}>
          <div style={{ fontWeight: "bold", fontSize: fsPrimary, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.code}
          </div>
          {fields.secondary && (
            <div style={{ fontSize: fsSub, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.zone_name}
            </div>
          )}
          {item.notes && (
            <div style={{ fontSize: fsSub, color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.notes}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Product Zebra (QR left, name + sku right) ────────────────────────────────
  if (mode === "zebra") {
    return (
      <div style={outer}>
        {qrEl}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", gap }}>
          <div style={{ fontWeight: "bold", fontSize: fsPrimary, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.name}
          </div>
          <div style={{ fontSize: fsSub, color: "#555", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.sku}
          </div>
          {item.categories?.length ? (
            <div style={{ fontSize: fsSub, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.categories.slice(0, 2).join(", ")}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ── Product A4 (photo | name+categories | Code128 barcode) ──────────────────
  //
  //   [photo sqMm×sqMm] | [flex-1 text] | [barcode]
  //
  const bcAreaH = `${sqMm * 0.88}mm`;   // barcode image height
  const bcAreaW = `${cfg.wMm * 0.38}mm`; // barcode column width

  return (
    <div style={outer}>
      {/* Photo (optional) */}
      {fields.photo && (
        <div style={{
          width: `${sqMm}mm`, height: `${sqMm}mm`, flexShrink: 0,
          overflow: "hidden", borderRadius: "0.5mm",
          background: "#f5f5f5", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {imgDataUrl
            ? <img src={imgDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            : <span style={{ fontSize: `${Math.max(2, sqMm * 0.22)}mm`, color: "#ccc" }}>фото</span>
          }
        </div>
      )}

      {/* Name + categories */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", gap }}>
        <div style={{
          fontWeight: "bold", fontSize: fsPrimary, lineHeight: 1.2,
          overflow: "hidden",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {item.name}
        </div>
        {fields.secondary && item.categories?.length ? (
          <div style={{ fontSize: fsSub, color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.categories.slice(0, 3).join(" · ")}
          </div>
        ) : null}
        <div style={{ fontSize: fsSub, color: "#999", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.sku}
        </div>
      </div>

      {/* Code128 barcode */}
      <div style={{ flexShrink: 0, width: bcAreaW, height: `${sqMm}mm`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {barcodeDataUrl
          ? <img src={barcodeDataUrl} alt={item.barcode || item.sku} style={{ height: bcAreaH, width: "100%", objectFit: "contain", display: "block" }} />
          : <div style={{ width: "100%", height: bcAreaH, background: "#f5f5f5", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: `${Math.max(1.8, sqMm * 0.14)}mm`, color: "#bbb" }}>штрих-код</span>
            </div>
        }
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export function WarehouseLabelModal({
  items,
  onClose,
}: {
  items: WarehouseLabelItem[];
  onClose: () => void;
}) {
  const isProduct = items[0]?.type === "product";
  const initMode: PrintMode = isProduct ? "a4" : "zebra";

  const [mode,     setMode]     = useState<PrintMode>(initMode);
  const [sizeKey,  setSizeKey]  = useState<LabelSize>(() => DEFAULT_SIZE[initMode]);
  const [fields,   setFields]   = useState<LabelFields>(DEFAULT_FIELDS);
  const [customQr, setCustomQr] = useState(() => defaultQr(items[0]));
  const [status,   setStatus]   = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [imgUrls,      setImgUrls]      = useState<Record<number, string>>({});
  const [barcodeUrls,  setBarcodeUrls]  = useState<Record<number, string>>({});
  const hiddenRef = useRef<HTMLDivElement>(null);
  const inFlight  = useRef(false);

  const cfg      = SIZES.find(s => s.key === sizeKey)!;
  const isSingle = items.length === 1;

  // Pre-fetch images + pre-render Code128 barcodes for A4 print capture
  useEffect(() => {
    if (!isProduct) return;

    const hPx = Math.round(cfg.hMm * (96 / 25.4));

    items.forEach(item => {
      if (item.type !== "product") return;

      if (item.image_url) {
        fetchDataUrl(item.image_url).then(url => {
          if (url) setImgUrls(prev => ({ ...prev, [item.id]: url }));
        });
      }

      const barcodeText = item.barcode || item.sku || `PROD:${item.id}`;
      generateCode128Url(barcodeText, hPx).then(url => {
        if (url) setBarcodeUrls(prev => ({ ...prev, [item.id]: url }));
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function switchMode(m: PrintMode) {
    setMode(m);
    setSizeKey(DEFAULT_SIZE[m]);
  }

  function getQrVal(item: WarehouseLabelItem): string {
    return isSingle ? (customQr || defaultQr(item)) : defaultQr(item);
  }

  // ── A4 print ─────────────────────────────────────────────────────────────────
  function printA4() {
    const container = hiddenRef.current;
    if (!container) return;

    // Strip explicit SVG width/height attrs so CSS can control sizing
    const labelHtml = Array.from(container.children)
      .map(el => el.outerHTML.replace(/<svg ([^>]*?)width="\d+" height="\d+"/g, "<svg $1"))
      .join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:A4;margin:8mm}
  body{display:flex;flex-wrap:wrap;gap:1.5mm;align-content:flex-start;background:#fff;padding:0}
  svg{width:100%!important;height:100%!important;display:block!important}
  img{display:block}
</style></head><body>
${labelHtml}
<script>window.onload=function(){setTimeout(function(){window.print();},500);}</script>
</body></html>`;

    const w = window.open("", "_blank");
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  }

  // ── Zebra ZPL ────────────────────────────────────────────────────────────────
  async function printZebra() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setStatus(null);

    const zpl = buildZpl(items, items.map(getQrVal), sizeKey, fields);
    const result = await sendToBrowserPrint(zpl);
    setStatus(
      result === "ok"            ? "✓ Відправлено на Zebra"             :
      result === "not_available" ? "✗ Zebra Browser Print не знайдено" :
                                   "✗ Помилка відправки",
    );
    inFlight.current = false; setBusy(false);
  }

  // ── Preview ──────────────────────────────────────────────────────────────────
  const PREVIEW_W = 260;
  const naturalW  = cfg.wMm * PX_PER_MM;
  const naturalH  = cfg.hMm * PX_PER_MM;
  const scale     = PREVIEW_W / naturalW;
  const previewH  = Math.round(naturalH * scale);

  const inputCls = "rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-sm font-mono outline-none focus:border-[var(--border-focus)]";

  const previewItem  = items[0];
  const previewImg   = previewItem.type === "product" ? imgUrls[previewItem.id]     : undefined;
  const previewBC    = previewItem.type === "product" ? barcodeUrls[previewItem.id] : undefined;

  // Field toggles depend on item type and mode
  const fieldRows = [
    ...(isProduct && mode === "a4" ? [{ key: "photo"     as keyof LabelFields, label: "Фото" }] : []),
    ...(isProduct ? [{ key: "secondary" as keyof LabelFields, label: "Категорії" }] : []),
    ...(!isProduct ? [{ key: "secondary" as keyof LabelFields, label: "Назва зони" }] : []),
  ];

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={
          items.length > 1
            ? `Мітки — ${items.length} ${isProduct ? "позицій" : "комірок"}`
            : `Мітка — ${isProduct
                ? (items[0] as Extract<WarehouseLabelItem, { type: "product" }>).name
                : (items[0] as Extract<WarehouseLabelItem, { type: "cell" }>).code}`
        }
        footer={
          <>
            {status && (
              <span className={`mr-auto text-xs truncate max-w-xs ${status.startsWith("✓") ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>
                {status}
              </span>
            )}
            <button onClick={onClose} className="btn btn-ghost">Закрити</button>
            <button onClick={printZebra} disabled={busy} className="btn btn-secondary disabled:opacity-50">
              {busy ? "…" : "Zebra (ZPL)"}
            </button>
            <button onClick={printA4} className="btn btn-primary">
              🖨 Друк A4
            </button>
          </>
        }
      >
        <div className="grid grid-cols-[auto_1fr] gap-6">

          {/* Preview */}
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Превью</p>
            <div
              className="flex items-center justify-center rounded-lg bg-[var(--surface-hi)] p-3"
              style={{ width: PREVIEW_W + 24 }}
            >
              <div style={{ width: PREVIEW_W, height: previewH, overflow: "hidden" }}>
                <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: naturalW, height: naturalH }}>
                  <LabelCard
                    item={previewItem}
                    qrVal={getQrVal(previewItem)}
                    cfg={cfg}
                    fields={fields}
                    mode={mode}
                    imgDataUrl={previewImg}
                    barcodeDataUrl={previewBC}
                  />
                </div>
              </div>
            </div>
            {items.length > 1 && (
              <p className="mt-1.5 text-center text-[10px] text-[var(--text-faint)]">
                {items.length} міток · показано першу
              </p>
            )}
          </div>

          {/* Settings */}
          <div className="space-y-4">

            {/* Mode toggle (products only) */}
            {isProduct && (
              <div>
                <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Формат</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    { key: "a4" as PrintMode,    label: "A4 / фото папір" },
                    { key: "zebra" as PrintMode,  label: "Zebra (термо)"  },
                  ]).map(m => (
                    <button key={m.key} type="button" onClick={() => switchMode(m.key)}
                      className={[
                        "rounded-lg border py-1.5 text-xs font-medium transition",
                        mode === m.key
                          ? "border-[var(--border-strong)] bg-[var(--accent)] text-white"
                          : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                      ].join(" ")}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Size */}
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Розмір</p>
              <div className="grid grid-cols-2 gap-1.5">
                {SIZES.map(s => (
                  <button key={s.key} type="button" onClick={() => setSizeKey(s.key)}
                    className={[
                      "rounded-lg border py-1.5 text-xs font-medium transition",
                      sizeKey === s.key
                        ? "border-[var(--border-strong)] bg-[var(--accent)] text-white"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
                    ].join(" ")}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* QR / barcode content (single item) */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">
                {mode === "a4" && isProduct ? "Вміст штрих-коду" : "Вміст QR"}
              </p>
              {isSingle ? (
                <>
                  <input
                    value={customQr}
                    onChange={e => setCustomQr(e.target.value)}
                    className={`${inputCls} w-full text-xs`}
                  />
                  {customQr !== defaultQr(items[0]) && (
                    <button type="button"
                      onClick={() => setCustomQr(defaultQr(items[0]))}
                      className="mt-1 text-[10px] text-[var(--text-faint)] hover:text-[var(--text)] underline underline-offset-2">
                      Скинути до {defaultQr(items[0])}
                    </button>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-faint)]">
                  {items[0].type === "cell"
                    ? <>Кожна: <span className="font-mono">CELL:{"{id}"}</span></>
                    : <>Кожна: штрих-код або <span className="font-mono">{"{sku}"}</span></>
                  }
                </div>
              )}
            </div>

            {/* Field toggles */}
            {fieldRows.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Показувати</p>
                <div className="space-y-2">
                  {fieldRows.map(({ key, label }) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={fields[key]}
                        onChange={() => setFields(prev => ({ ...prev, [key]: !prev[key] }))}
                        className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-neutral-900 dark:accent-neutral-100"
                      />
                      <span className="text-xs text-[var(--text)]">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      </Modal>

      {/* Hidden labels for A4 print capture — rendered in portal so they are outside the modal's overflow */}
      {createPortal(
        <div
          ref={hiddenRef}
          style={{ position: "fixed", top: 0, left: 0, opacity: 0, pointerEvents: "none", zIndex: -1 }}
        >
          {items.map((item, i) => (
            <LabelCard
              key={i}
              item={item}
              qrVal={getQrVal(item)}
              cfg={cfg}
              fields={fields}
              mode={mode}
              imgDataUrl={item.type === "product" ? imgUrls[item.id]     : undefined}
              barcodeDataUrl={item.type === "product" ? barcodeUrls[item.id] : undefined}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
