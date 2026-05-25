"use client";

import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { api } from "@/lib/api";
import type { Filament } from "@/lib/types";
import { LABEL_DIMS, LabelPreview, type LabelTemplate } from "./LabelPreview";

interface LabelData {
  qr_code_base64: string | null;
}

export function LabelGeneratorModal({
  filaments,
  onClose,
}: {
  filaments: Filament[];
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<LabelTemplate>("standard");
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

  async function downloadPdf() {
    if (busy) return;
    setBusy(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const resp = await fetch("/api/filaments/labels/pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ filament_ids: filaments.map(f => f.id), template }),
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
    a.download = `label-${preview?.sku ?? preview?.id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        filaments.length > 1
          ? `Лейбли (${filaments.length} котушок)`
          : `Лейбл — ${preview?.color}`
      }
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Закрити
          </button>
          <button
            type="button"
            onClick={downloadSvg}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            ↓ SVG
          </button>
          <button
            type="button"
            onClick={downloadPdf}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "Генерую…" : "↓ PDF"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* template selector */}
        <div>
          <p className="mb-2 text-xs font-medium text-neutral-500">Шаблон</p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(LABEL_DIMS) as LabelTemplate[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTemplate(t)}
                className={[
                  "rounded-lg border py-2 text-xs font-medium transition",
                  template === t
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800",
                ].join(" ")}
              >
                {LABEL_DIMS[t].label}
              </button>
            ))}
          </div>
        </div>

        {/* preview */}
        {preview && (
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-500">Превью</p>
            <div className="flex justify-center overflow-auto rounded-lg bg-neutral-50 p-4 dark:bg-neutral-800">
              <LabelPreview filament={preview} template={template} qrBase64={qr} />
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
