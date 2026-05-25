"use client";

import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { api } from "@/lib/api";
import type { Filament } from "@/lib/types";
import {
  DEFAULT_FIELDS,
  LABEL_DIMS,
  LabelPreview,
  type BarcodeType,
  type LabelFields,
  type LabelTemplate,
} from "./LabelPreview";

interface LabelData { qr_code_base64: string | null }

const FIXED_TEMPLATES = Object.keys(LABEL_DIMS) as Exclude<LabelTemplate, "custom">[];

const FIELD_LABELS: { key: keyof LabelFields; label: string }[] = [
  { key: "barcode",       label: "Баркод" },
  { key: "labelId",       label: "ID котушки" },
  { key: "brandMaterial", label: "Матеріал" },
  { key: "colorName",     label: "Назва кольору" },
  { key: "sku",           label: "SKU котушки" },
  { key: "progress",      label: "Залишок %" },
];

const ID_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ23456789";
function genLabelId() {
  return Array.from({ length: 4 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");
}

// ── ZPL helpers ───────────────────────────────────────────────────────────────

function toZplSafe(s: string): string {
  // Strip chars ZPL can't handle reliably in ^FD
  return s.replace(/[\\^~]/g, "").slice(0, 28);
}

function buildZpl(f: Filament, labelId: string, barcodeType: BarcodeType): string {
  const color    = toZplSafe(f.color);
  const mat      = toZplSafe([f.brand, f.material].filter(Boolean).join(" "));
  const sku      = toZplSafe(f.sku ?? "");
  const barText  = labelId || f.sku || `FL${f.id}`;

  const lines = [
    "^XA",
    "^CI28",
    "^LH0,0",
    "^PW680",    // 85mm @ 203dpi
    "^LL432",    // 54mm @ 203dpi
    `^FO20,18^A0N,34,30^FD${color}^FS`,
    `^FO20,60^A0N,24,22^FD${mat}^FS`,
    labelId ? `^FO20,94^A0N,56,50^FD${labelId}^FS` : "",
    sku      ? `^FO20,170^A0N,20,18^FD${sku}^FS`   : "",
    barcodeType !== "none" ? `^FO20,200^BY2,2.5,80^BCN,80,N,N,N^FD${barText}^FS` : "",
    "^XZ",
  ];
  return lines.filter(Boolean).join("\n");
}

async function sendViaBrowserPrint(zpl: string): Promise<"ok" | "not_available" | "error"> {
  try {
    const devResp = await fetch("http://localhost:9090/default", {
      signal: AbortSignal.timeout(1200),
    });
    if (!devResp.ok) return "not_available";
    const device = await devResp.json() as Record<string, unknown>;

    const writeResp = await fetch("http://localhost:9090/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, data: zpl }),
      signal: AbortSignal.timeout(3000),
    });
    return writeResp.ok ? "ok" : "error";
  } catch {
    return "not_available";
  }
}

// ── component ─────────────────────────────────────────────────────────────────

export function LabelGeneratorModal({
  filaments,
  onClose,
}: {
  filaments: Filament[];
  onClose: () => void;
}) {
  const [template, setTemplate]         = useState<LabelTemplate>("standard");
  const [barcodeType, setBarcodeType]   = useState<BarcodeType>("code128");
  const [customWStr, setCustomWStr]     = useState("85");
  const [customHStr, setCustomHStr]     = useState("54");
  const [fields, setFields]             = useState<LabelFields>(DEFAULT_FIELDS);
  // Use the spool's stored label_id; fall back to random only if missing
  const [labelId, setLabelId]           = useState(() => filaments[0]?.label_id || genLabelId());
  const [busy, setBusy]                 = useState(false);
  const [printBusy, setPrintBusy]       = useState(false);
  const [pdfError, setPdfError]         = useState<string | null>(null);
  const [printStatus, setPrintStatus]   = useState<string | null>(null);
  const [qr, setQr]                     = useState<string | null>(null);

  const customW = Math.max(20, Math.min(300, parseInt(customWStr) || 85));
  const customH = Math.max(15, Math.min(200, parseInt(customHStr) || 54));

  const preview = filaments[0];

  useEffect(() => {
    if (!preview) return;
    setQr(null);
    api<LabelData>(`/api/filaments/${preview.id}/label-data`)
      .then(d => setQr(d.qr_code_base64))
      .catch(() => {});
  }, [preview?.id]);

  function toggleField(key: keyof LabelFields) {
    setFields(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function normId(v: string) {
    return v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  }

  // ── PDF download ─────────────────────────────────────────────────────────────
  async function downloadPdf() {
    if (busy) return;
    setBusy(true); setPdfError(null);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const body: Record<string, unknown> = {
        filament_ids: filaments.map(f => f.id),
        template,
        barcode_type: barcodeType,
        label_id: labelId || null,
        show_qr:       fields.barcode && barcodeType === "qr",
        show_color:    fields.colorName,
        show_brand:    fields.brandMaterial,
        show_sku:      fields.sku,
        show_progress: fields.progress,
        show_label_id: fields.labelId,
      };
      if (template === "custom") { body.custom_w_mm = customW; body.custom_h_mm = customH; }
      const resp = await fetch("/api/filaments/labels/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = await resp.json().then((d: { detail?: string }) => d.detail).catch(() => resp.statusText);
        throw new Error(detail || "PDF error");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "filament-labels.pdf"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "PDF error");
    } finally { setBusy(false); }
  }

  // ── SVG download ─────────────────────────────────────────────────────────────
  function downloadSvg() {
    const el = document.getElementById("label-preview-svg");
    if (!el) return;
    const blob = new Blob([el.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `label-${labelId || preview?.sku || preview?.id}.svg`; a.click();
    URL.revokeObjectURL(url);
  }

  // ── ZPL / Zebra direct print ──────────────────────────────────────────────
  async function printZebra() {
    if (printBusy) return;
    setPrintBusy(true); setPrintStatus(null);
    const zpl = filaments.map(f => buildZpl(f, labelId, barcodeType)).join("\n");
    const result = await sendViaBrowserPrint(zpl);
    if (result === "ok") {
      setPrintStatus("✓ Відправлено на принтер");
    } else if (result === "not_available") {
      setPrintStatus("✗ Zebra Browser Print не знайдено. Встановіть застосунок.");
    } else {
      setPrintStatus("✗ Помилка відправки");
    }
    setPrintBusy(false);
  }

  const inputCls = "rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-400";

  return (
    <Modal open={true} onClose={onClose}
      title={filaments.length > 1 ? `Лейбли (${filaments.length} котушок)` : `Лейбл — ${preview?.color}`}
      size="xl"
      footer={
        <>
          {(pdfError || printStatus) && (
            <span className={`mr-auto text-xs truncate max-w-xs ${pdfError ? "text-red-500" : "text-neutral-500"}`}>
              {pdfError ?? printStatus}
            </span>
          )}
          <button type="button" onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Закрити
          </button>
          <button type="button" onClick={printZebra} disabled={printBusy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            {printBusy ? "…" : "Друкувати"}
          </button>
          <button type="button" onClick={downloadSvg}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            ↓ SVG
          </button>
          <button type="button" onClick={downloadPdf} disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
            {busy ? "Генерую…" : "↓ PDF"}
          </button>
        </>
      }
    >
      <div className="space-y-4">

        {/* template + barcode row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-500">Шаблон</p>
            <div className="grid grid-cols-2 gap-1.5">
              {FIXED_TEMPLATES.map(t => (
                <button key={t} type="button" onClick={() => setTemplate(t)}
                  className={["rounded-lg border py-1.5 text-xs font-medium transition",
                    template === t
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                      : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                  ].join(" ")}>{LABEL_DIMS[t].label}</button>
              ))}
              <button type="button" onClick={() => setTemplate("custom")}
                className={["col-span-2 rounded-lg border py-1.5 text-xs font-medium transition",
                  template === "custom"
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                ].join(" ")}>Свій розмір</button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium text-neutral-500">Тип баркоду</p>
              <div className="grid grid-cols-3 gap-1.5">
                {(["code128", "qr", "none"] as BarcodeType[]).map(bt => (
                  <button key={bt} type="button" onClick={() => setBarcodeType(bt)}
                    className={["rounded-lg border py-1.5 text-xs font-medium transition",
                      barcodeType === bt
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                        : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                    ].join(" ")}>
                    {bt === "qr" ? "QR" : bt === "code128" ? "Code128" : "Немає"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-neutral-500">ID котушки</p>
              <div className="flex items-center gap-2">
                <input type="text" value={labelId} maxLength={4} placeholder="A12B"
                  onChange={e => setLabelId(normId(e.target.value))}
                  className={`${inputCls} w-20 font-mono text-base tracking-widest`} />
                <button type="button" onClick={() => setLabelId(genLabelId())}
                  title="Новий ID"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
                  ↻
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* custom dimensions — free-text inputs, validated on use */}
        {template === "custom" && (
          <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-800/50">
            <span className="text-xs text-neutral-500">Розмір (мм)</span>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-400">Ш</span>
              <input type="text" inputMode="numeric" value={customWStr}
                onChange={e => setCustomWStr(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => setCustomWStr(String(Math.max(20, Math.min(300, parseInt(customWStr) || 85))))}
                className={`${inputCls} w-16 tabular-nums`} />
            </label>
            <span className="text-neutral-300 dark:text-neutral-600">×</span>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-400">В</span>
              <input type="text" inputMode="numeric" value={customHStr}
                onChange={e => setCustomHStr(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => setCustomHStr(String(Math.max(15, Math.min(200, parseInt(customHStr) || 54))))}
                className={`${inputCls} w-16 tabular-nums`} />
            </label>
            <span className="text-xs text-neutral-400">
              → {customW}×{customH} мм
            </span>
          </div>
        )}

        {/* field toggles */}
        <div>
          <p className="mb-2 text-xs font-medium text-neutral-500">Вміст лейблу</p>
          <div className="grid grid-cols-3 gap-y-1.5 gap-x-4">
            {FIELD_LABELS.map(({ key, label }) => (
              <label key={key} className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={fields[key]} onChange={() => toggleField(key)}
                  className="h-3.5 w-3.5 rounded border-neutral-300 accent-neutral-900 dark:accent-neutral-100" />
                <span className="text-xs text-neutral-700 dark:text-neutral-300">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* preview */}
        {preview && (
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-500">Превью</p>
            <div className="flex justify-center overflow-auto rounded-lg bg-neutral-100 p-4 dark:bg-neutral-800">
              <LabelPreview
                filament={preview}
                template={template}
                barcodeType={barcodeType}
                qrBase64={qr}
                labelId={labelId || null}
                customWmm={customW}
                customHmm={customH}
                fields={fields}
              />
            </div>
            {filaments.length > 1 && (
              <p className="mt-1.5 text-center text-xs text-neutral-400">
                Показано першу котушку · всього {filaments.length} лейблів у PDF
              </p>
            )}
          </div>
        )}

      </div>
    </Modal>
  );
}
