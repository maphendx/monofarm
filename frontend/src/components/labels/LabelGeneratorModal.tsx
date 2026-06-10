"use client";

import { useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { API_URL, api, getToken } from "@/lib/api";
import type { Filament, GcodeFile } from "@/lib/types";
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

let _bpLibLoaded = false;
async function _loadBPLib(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (_bpLibLoaded || (window as any).BrowserPrint) { _bpLibLoaded = true; return true; }
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/BrowserPrint.min.js";
    s.onload = () => { _bpLibLoaded = true; resolve(true); };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function sendViaBrowserPrint(zpl: string): Promise<"ok" | "not_available" | "blocked" | "error"> {
  const loaded = await _loadBPLib();
  if (!loaded) return "not_available";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BP = (window as any).BrowserPrint;
  return new Promise((resolve) => {
    BP.getDefaultDevice("printer",
      (device: Record<string, unknown> & { send: Function }) => {
        if (!device) { resolve("not_available"); return; }
        device.send(zpl, () => resolve("ok"), () => resolve("error"));
      },
      () => resolve("blocked"),
    );
  });
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
    api<LabelData>(`/api/materials/${preview.id}/label-data`)
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
      const token = typeof window !== "undefined" ? getToken() : null;
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
      const resp = await fetch(`${API_URL}/api/materials/labels/pdf`, {
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
      const win = window.open(url, "_blank");
      if (!win) {
        // popup blocked — fall back to download
        const a = document.createElement("a");
        a.href = url; a.download = "filament-labels.pdf"; a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
      setPrintStatus("✗ Zebra Browser Print не знайдено. Встановіть з zebra.com/browserprint");
    } else if (result === "blocked") {
      setPrintStatus("✗ Chrome заблокував доступ. Відкрийте chrome://flags/#block-insecure-private-network-requests → Disabled");
    } else {
      setPrintStatus("✗ Помилка відправки");
    }
    setPrintBusy(false);
  }

  const inputCls = "rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--border-focus)]   dark:focus:border-[var(--border-strong)]";

  return (
    <Modal open={true} onClose={onClose}
      title={filaments.length > 1 ? `Лейбли (${filaments.length} котушок)` : `Лейбл — ${preview?.color}`}
      size="xl"
      footer={
        <>
          {(pdfError || printStatus) && (
            <span className={`mr-auto text-xs truncate max-w-xs ${pdfError ? "text-[var(--state-error)]" : "text-[var(--text-muted)]"}`}>
              {pdfError ?? printStatus}
            </span>
          )}
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Закрити
          </button>
          <button type="button" onClick={printZebra} disabled={printBusy}
            className="btn btn-secondary disabled:opacity-50">
            {printBusy ? "…" : "Друкувати"}
          </button>
          <button type="button" onClick={downloadSvg} className="btn btn-secondary">
            ↓ SVG
          </button>
          <button type="button" onClick={downloadPdf} disabled={busy}
            className="btn btn-primary disabled:opacity-50">
            {busy ? "Генерую…" : "Друкувати PDF"}
          </button>
        </>
      }
    >
      <div className="space-y-4">

        {/* template + barcode row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Шаблон</p>
            <div className="grid grid-cols-2 gap-1.5">
              {FIXED_TEMPLATES.map(t => (
                <button key={t} type="button" onClick={() => setTemplate(t)}
                  className={["rounded-lg border py-1.5 text-xs font-medium transition",
                    template === t
                      ? "border-[var(--border-strong)] bg-[var(--accent)] text-white   "
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ",
                  ].join(" ")}>{LABEL_DIMS[t].label}</button>
              ))}
              <button type="button" onClick={() => setTemplate("custom")}
                className={["col-span-2 rounded-lg border py-1.5 text-xs font-medium transition",
                  template === "custom"
                    ? "border-[var(--border-strong)] bg-[var(--accent)] text-white   "
                    : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ",
                ].join(" ")}>Свій розмір</button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Тип баркоду</p>
              <div className="grid grid-cols-3 gap-1.5">
                {(["code128", "qr", "none"] as BarcodeType[]).map(bt => (
                  <button key={bt} type="button" onClick={() => setBarcodeType(bt)}
                    className={["rounded-lg border py-1.5 text-xs font-medium transition",
                      barcodeType === bt
                        ? "border-[var(--border-strong)] bg-[var(--accent)] text-white   "
                        : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   ",
                    ].join(" ")}>
                    {bt === "qr" ? "QR" : bt === "code128" ? "Code128" : "Немає"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-[var(--text-muted)]">ID котушки</p>
              <div className="flex items-center gap-2">
                <input type="text" value={labelId} maxLength={4} placeholder="A12B"
                  onChange={e => setLabelId(normId(e.target.value))}
                  className={`${inputCls} w-20 font-mono text-base tracking-widest`} />
                <button type="button" onClick={() => setLabelId(genLabelId())}
                  title="Новий ID"
                  className="btn btn-secondary btn-sm">
                  ↻
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* custom dimensions — free-text inputs, validated on use */}
        {template === "custom" && (
          <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5  ">
            <span className="text-xs text-[var(--text-muted)]">Розмір (мм)</span>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--text-faint)]">Ш</span>
              <input type="text" inputMode="numeric" value={customWStr}
                onChange={e => setCustomWStr(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => setCustomWStr(String(Math.max(20, Math.min(300, parseInt(customWStr) || 85))))}
                className={`${inputCls} w-16 tabular-nums`} />
            </label>
            <span className="text-[var(--text-muted)] ">×</span>
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--text-faint)]">В</span>
              <input type="text" inputMode="numeric" value={customHStr}
                onChange={e => setCustomHStr(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => setCustomHStr(String(Math.max(15, Math.min(200, parseInt(customHStr) || 54))))}
                className={`${inputCls} w-16 tabular-nums`} />
            </label>
            <span className="text-xs text-[var(--text-faint)]">
              → {customW}×{customH} мм
            </span>
          </div>
        )}

        {/* field toggles */}
        <div>
          <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Вміст лейблу</p>
          <div className="grid grid-cols-3 gap-y-1.5 gap-x-4">
            {FIELD_LABELS.map(({ key, label }) => (
              <label key={key} className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={fields[key]} onChange={() => toggleField(key)}
                  className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-neutral-900 dark:accent-neutral-100" />
                <span className="text-xs text-[var(--text)] ">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* preview */}
        {preview && (
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Превью</p>
            <div className="flex justify-center overflow-auto rounded-lg bg-[var(--surface-hi)] p-4 ">
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
              <p className="mt-1.5 text-center text-xs text-[var(--text-faint)]">
                Показано першу котушку · всього {filaments.length} лейблів у PDF
              </p>
            )}
          </div>
        )}

      </div>
    </Modal>
  );
}
