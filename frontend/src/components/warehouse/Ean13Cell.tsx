"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getEan13Value } from "@/lib/ean13";
import { generateEan13Svg } from "./labelUtils";

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function Ean13Cell({ barcode }: { barcode: string | null }) {
  const ean13 = useMemo(() => getEan13Value(barcode), [barcode]);
  const [svg, setSvg] = useState<string | null>(null);
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    if (!ean13) return () => { active = false; };
    generateEan13Svg(ean13).then((value) => {
      if (active) setSvg(value);
    });
    return () => { active = false; };
  }, [ean13]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  if (!ean13) return <span className="text-[var(--text-faint)]">—</span>;

  const imageUrl = svg ? svgDataUrl(svg) : null;

  function cancelClose() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPreviewRect(null), 120);
  }

  function showPreview(event: React.MouseEvent<HTMLDivElement>) {
    cancelClose();
    setPreviewRect(event.currentTarget.getBoundingClientRect());
  }

  async function copySvg() {
    if (!svg) return;
    try {
      const svgBlob = new Blob([svg], { type: "image/svg+xml" });
      const textBlob = new Blob([svg], { type: "text/plain" });
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/svg+xml": svgBlob, "text/plain": textBlob }),
        ]);
      } else {
        await navigator.clipboard.writeText(svg);
      }
      toast.success("SVG EAN-13 скопійовано");
    } catch {
      toast.error("Не вдалося скопіювати SVG");
    }
  }

  const previewTop = previewRect
    ? previewRect.bottom + 8 + 250 > window.innerHeight
      ? previewRect.top - 258
      : previewRect.bottom + 8
    : 0;
  const previewLeft = previewRect
    ? Math.min(previewRect.left, Math.max(8, window.innerWidth - 328))
    : 0;

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={showPreview}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        disabled={!imageUrl}
        title={imageUrl ? "Наведіть для preview та копіювання SVG" : "Генерую SVG…"}
        className="block min-w-36 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--surface-hi)] disabled:cursor-wait"
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={`EAN-13 ${ean13}`} className="h-9 w-32 object-contain object-left" />
        ) : (
          <span className="font-mono text-xs text-[var(--text-muted)]">{ean13}</span>
        )}
      </button>

      {previewRect && imageUrl && (
        <div
          className="fixed z-[9999] w-80 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 shadow-2xl"
          style={{ left: previewLeft, top: previewTop }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={`EAN-13 ${ean13}`} className="w-full object-contain" />
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-2">
            <code className="text-xs font-semibold tracking-[0.12em]">{ean13}</code>
            <button type="button" onClick={copySvg} className="btn btn-primary btn-sm shrink-0">
              Скопіювати SVG
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
