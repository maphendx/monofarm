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

interface LabelData {
  qr_code_base64: string | null;
}

const FIXED_TEMPLATES = Object.keys(LABEL_DIMS) as Exclude<LabelTemplate, "custom">[];

const FIELD_LABELS: { key: keyof LabelFields; label: string }[] = [
  { key: "barcode",       label: "Баркод" },
  { key: "colorName",     label: "Назва кольору" },
  { key: "brandMaterial", label: "Виробник · Матеріал" },
  { key: "labelId",       label: "ID лейблу" },
  { key: "sku",           label: "SKU котушки" },
  { key: "progress",      label: "Залишок %" },
];

const ID_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ23456789";
function genLabelId(): string {
  return Array.from({ length: 4 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join("");
}

export function LabelGeneratorModal({
  filaments,
  onClose,
}: {
  filaments: Filament[];
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<LabelTemplate>("standard");
  const [barcodeType, setBarcodeType] = useState<BarcodeType>("qr");
  const [customW, setCustomW] = useState(85);
  const [customH, setCustomH] = useState(54);
  const [fields, setFields] = useState<LabelFields>(DEFAULT_FIELDS);
  const [labelId, setLabelId] = useState(() => genLabelId());
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

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

  function normalizeLabelId(v: string) {
    return v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  }

  async function downloadPdf() {
    if (busy) return;
    setBusy(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const body: Record<string, unknown> = {
        filament_ids: filaments.map(f => f.id),
        template,
        barcode_type: barcodeType,
        label_id: labelId || null,
        show_qr: fields.barcode && barcodeType === "qr",
        show_color: fields.colorName,
        show_brand: fields.brandMaterial,
        show_sku: fields.sku,
        show_progress: fields.progress,
        show_label_id: fields.labelId,
      };
      if (template === "custom") {
        body.custom_w_mm = customW;
        body.custom_h_mm = customH;
      }
      const resp = await fetch("/api/filaments/labels/pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error("PDF error");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "filament-labels.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  function downloadSvg() {
    const el = document.getElementById("label-preview-svg");
    if (!el) return;
    const blob = new Blob([el.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `label-${labelId || preview?.sku || preview?.id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls = "rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm tabular-nums outline-none focus:border-neutral-600 dark:border-neutral-700 dark:bg-neutral-950";

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={filaments.length > 1 ? `Лейбли (${filaments.length} котушок)` : `Лейбл — ${preview?.color}`}
      size="xl"
      footer={
        <>
          <button type="button" onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Закрити
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
        {/* template + barcode type row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-500">Шаблон</p>
            <div className="grid grid-cols-2 gap-1.5">
              {FIXED_TEMPLATES.map(t => (
                <button key={t} type="button" onClick={() => setTemplate(t)}
                  className={[
                    "rounded-lg border py-1.5 text-xs font-medium transition",
                    template === t
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                      : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                  ].join(" ")}
                >
                  {LABEL_DIMS[t].label}
                </button>
              ))}
              <button type="button" onClick={() => setTemplate("custom")}
                className={[
                  "col-span-2 rounded-lg border py-1.5 text-xs font-medium transition",
                  template === "custom"
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                ].join(" ")}
              >
                Свій розмір
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="mb-2 text-xs font-medium text-neutral-500">Тип баркоду</p>
              <div className="grid grid-cols-3 gap-1.5">
                {(["qr", "code128", "none"] as BarcodeType[]).map(bt => (
                  <button key={bt} type="button" onClick={() => setBarcodeType(bt)}
                    className={[
                      "rounded-lg border py-1.5 text-xs font-medium transition",
                      barcodeType === bt
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                        : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                    ].join(" ")}
                  >
                    {bt === "qr" ? "QR" : bt === "code128" ? "Code128" : "Немає"}
                  </button>
                ))}
              </div>
            </div>

            {/* label ID */}
            <div>
              <p className="mb-1 text-xs font-medium text-neutral-500">ID лейблу</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={labelId}
                  onChange={e => setLabelId(normalizeLabelId(e.target.value))}
                  maxLength={4}
                  placeholder="A12B"
                  className={`${inputCls} w-20 font-mono text-base tracking-widest uppercase`}
                />
                <button type="button" onClick={() => setLabelId(genLabelId())}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
                  ↻
                </button>
                <span className="text-xs text-neutral-400">4 символи A-Z 0-9</span>
              </div>
            </div>
          </div>
        </div>

        {/* custom dimensions */}
        {template === "custom" && (
          <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-700 dark:bg-neutral-800/50">
            <span className="text-xs text-neutral-500">Розмір (мм)</span>
            <label className="flex items-center gap-1">
              <span className="text-xs text-neutral-400">Ш</span>
              <input type="number" min={20} max={300} value={customW}
                onChange={e => setCustomW(Math.max(20, parseInt(e.target.value) || 85))}
                className={`${inputCls} w-16`} />
            </label>
            <span className="text-neutral-300">×</span>
            <label className="flex items-center gap-1">
              <span className="text-xs text-neutral-400">В</span>
              <input type="number" min={15} max={200} value={customH}
                onChange={e => setCustomH(Math.max(15, parseInt(e.target.value) || 54))}
                className={`${inputCls} w-16`} />
            </label>
          </div>
        )}

        {/* field toggles */}
        <div>
          <p className="mb-2 text-xs font-medium text-neutral-500">Вміст лейблу</p>
          <div className="grid grid-cols-3 gap-y-1.5 gap-x-4">
            {FIELD_LABELS.map(({ key, label }) => (
              <label key={key} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={fields[key]}
                  onChange={() => toggleField(key)}
                  className="h-3.5 w-3.5 rounded border-neutral-300 accent-neutral-900 dark:accent-neutral-100"
                />
                <span className="text-xs text-neutral-700 dark:text-neutral-300">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* preview */}
        {preview && (
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-500">Превью</p>
            <div className="flex justify-center overflow-auto rounded-lg bg-neutral-50 p-4 dark:bg-neutral-800">
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
