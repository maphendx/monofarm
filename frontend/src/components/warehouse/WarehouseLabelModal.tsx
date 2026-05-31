"use client";

import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Modal } from "@/components/ui/Modal";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WarehouseLabelItem =
  | { type: "cell"; id: number; code: string; zone_name: string; notes?: string | null }
  | { type: "product"; id: number; name: string; sku: string; barcode?: string | null };

type LabelSize = "50x25" | "57x32" | "100x50" | "100x100";
type LabelFields = { secondary: boolean; tertiary: boolean };

// ─── Constants ────────────────────────────────────────────────────────────────

const SIZES = [
  { key: "50x25"   as LabelSize, label: "50×25 мм",   wMm: 50,  hMm: 25  },
  { key: "57x32"   as LabelSize, label: "57×32 мм",   wMm: 57,  hMm: 32  },
  { key: "100x50"  as LabelSize, label: "100×50 мм",  wMm: 100, hMm: 50  },
  { key: "100x100" as LabelSize, label: "100×100 мм", wMm: 100, hMm: 100 },
];

const DEFAULT_FIELDS: LabelFields = { secondary: true, tertiary: false };
const PX_PER_MM = 96 / 25.4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultQr(item: WarehouseLabelItem): string {
  return item.type === "cell" ? `CELL:${item.id}` : (item.barcode || `PROD:${item.sku}`);
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
    const tertiary  = item.type === "cell" ? (item.notes ?? "") : (item.barcode ?? "");

    return [
      "^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0",
      `^FO${pad},${qrY}^BQN,2,${mag}^FDMA,${safe(qrVals[i] ?? defaultQr(item))}^FS`,
      `^FO${txX},${Math.floor(H * 0.32)}^A0N,${fsP},${fsP}^FD${safe(primary)}^FS`,
      fields.secondary && secondary
        ? `^FO${txX},${Math.floor(H * 0.60)}^A0N,${fsS},${fsS}^FD${safe(secondary)}^FS`
        : "",
      fields.tertiary && tertiary
        ? `^FO${txX},${Math.floor(H * 0.80)}^A0N,${fsS},${fsS}^FD${safe(tertiary)}^FS`
        : "",
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
  } catch {
    return "not_available";
  }
}

// ─── LabelCard ────────────────────────────────────────────────────────────────

function LabelCard({
  item, qrVal, cfg, fields,
}: {
  item: WarehouseLabelItem;
  qrVal: string;
  cfg: (typeof SIZES)[number];
  fields: LabelFields;
}) {
  const pad    = 1.5;
  const qrMm   = cfg.hMm - pad * 2;
  const primary   = item.type === "cell" ? item.code : item.name;
  const secondary = item.type === "cell" ? item.zone_name : item.sku;
  const tertiary  = item.type === "cell" ? item.notes    : item.barcode;

  const fsPrimary = `${Math.max(3.5, cfg.hMm * 0.27)}mm`;
  const fsSub     = `${Math.max(2.2, cfg.hMm * 0.16)}mm`;
  const gap       = `${pad * 0.4}mm`;

  return (
    <div style={{
      width: `${cfg.wMm}mm`, height: `${cfg.hMm}mm`,
      border: "0.3mm solid #ccc", borderRadius: "1mm",
      display: "flex", flexDirection: "row", alignItems: "center",
      padding: `${pad}mm`, gap: `${pad}mm`,
      boxSizing: "border-box", background: "#fff", overflow: "hidden",
      fontFamily: "Arial, Helvetica, sans-serif",
    }}>
      <div style={{ width: `${qrMm}mm`, height: `${qrMm}mm`, flexShrink: 0 }}>
        <QRCode
          value={qrVal || " "}
          level="M"
          size={128}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
      <div style={{
        flex: 1, overflow: "hidden",
        display: "flex", flexDirection: "column", justifyContent: "center", gap,
      }}>
        <div style={{
          fontWeight: "bold", fontSize: fsPrimary, lineHeight: 1.1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {primary}
        </div>
        {fields.secondary && secondary && (
          <div style={{
            fontSize: fsSub, color: "#444",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {secondary}
          </div>
        )}
        {fields.tertiary && tertiary && (
          <div style={{
            fontSize: fsSub, color: "#888", fontFamily: "monospace",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {tertiary}
          </div>
        )}
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
  const [sizeKey,  setSizeKey]  = useState<LabelSize>("57x32");
  const [fields,   setFields]   = useState<LabelFields>(DEFAULT_FIELDS);
  const [customQr, setCustomQr] = useState(() => defaultQr(items[0]));
  const [status,   setStatus]   = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const hiddenRef = useRef<HTMLDivElement>(null);
  const inFlight  = useRef(false);

  const cfg      = SIZES.find(s => s.key === sizeKey)!;
  const isSingle = items.length === 1;

  function getQrVal(item: WarehouseLabelItem): string {
    return isSingle ? (customQr || defaultQr(item)) : defaultQr(item);
  }

  // ── A4 print ────────────────────────────────────────────────────────────────
  function printA4() {
    const container = hiddenRef.current;
    if (!container) return;

    const labelHtml = Array.from(container.children).map(el => el.outerHTML).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:A4;margin:10mm}
  body{display:flex;flex-wrap:wrap;gap:2mm;align-content:flex-start;background:#fff}
  svg{width:100%!important;height:100%!important;display:block}
</style></head><body>
${labelHtml}
<script>window.onload=()=>setTimeout(()=>window.print(),300)</script>
</body></html>`;

    const w = window.open("", "_blank");
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  }

  // ── Zebra ZPL ───────────────────────────────────────────────────────────────
  async function printZebra() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setStatus(null);

    const zpl = buildZpl(items, items.map(getQrVal), sizeKey, fields);
    const result = await sendToBrowserPrint(zpl);
    setStatus(
      result === "ok"            ? "✓ Відправлено на Zebra"              :
      result === "not_available" ? "✗ Zebra Browser Print не знайдено"  :
                                   "✗ Помилка відправки",
    );
    inFlight.current = false; setBusy(false);
  }

  // ── Preview ─────────────────────────────────────────────────────────────────
  const PREVIEW_W   = 248;
  const naturalW    = cfg.wMm * PX_PER_MM;
  const naturalH    = cfg.hMm * PX_PER_MM;
  const scale       = PREVIEW_W / naturalW;
  const previewH    = Math.round(naturalH * scale);

  const inputCls = "rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-sm font-mono outline-none focus:border-[var(--border-focus)]";

  const secondaryLabel = items[0].type === "cell" ? "Назва зони" : "Артикул (SKU)";
  const tertiaryLabel  = items[0].type === "cell" ? "Нотатка"   : "Штрих-код (текст)";

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={
          items.length > 1
            ? `Мітки — ${items.length} ${items[0].type === "cell" ? "комірок" : "позицій"}`
            : `Мітка — ${items[0].type === "cell" ? items[0].code : items[0].name}`
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
                <div style={{
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  width: naturalW,
                  height: naturalH,
                }}>
                  <LabelCard item={items[0]} qrVal={getQrVal(items[0])} cfg={cfg} fields={fields} />
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

            {/* QR content */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">Вміст QR</p>
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
                    : <>Кожна: штрих-код або <span className="font-mono">PROD:{"{sku}"}</span></>
                  }
                </div>
              )}
            </div>

            {/* Fields */}
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Показувати</p>
              <div className="space-y-2">
                {([
                  { key: "secondary" as const, label: secondaryLabel },
                  { key: "tertiary"  as const, label: tertiaryLabel  },
                ]).map(({ key, label }) => (
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

          </div>
        </div>
      </Modal>

      {/* Hidden labels used for A4 print capture (portal outside modal DOM) */}
      {createPortal(
        <div
          ref={hiddenRef}
          style={{ position: "fixed", top: 0, left: 0, opacity: 0, pointerEvents: "none", zIndex: -1 }}
        >
          {items.map((item, i) => (
            <LabelCard key={i} item={item} qrVal={getQrVal(item)} cfg={cfg} fields={fields} />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
