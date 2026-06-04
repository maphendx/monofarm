"use client";

import { useEffect } from "react";
import { useBodyScrollLock } from "@/components/ui/Modal";

// Mascot with variant expression
function ConfirmMascot({ variant }: { variant: "danger" | "warn" | "default" }) {
  const eyeColor = variant === "danger" ? "#ef4444" : variant === "warn" ? "#f59e0b" : "#083344";
  const B = "#0891b2";
  const S = "#0e7490";
  const F = "#cffafe";
  const A = "#22d3ee";
  return (
    <svg width={56} height={73} viewBox="0 0 10 13" shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated" }} aria-hidden>
      <rect x="4" y="0" width="2" height="1" fill={A} />
      <rect x="4" y="1" width="2" height="1" fill={B} />
      <rect x="2" y="2" width="6" height="1" fill={F} />
      <rect x="1" y="3" width="8" height="3" fill={F} />
      <rect x="2" y="6" width="6" height="1" fill={F} />
      <rect x="2" y="4" width="2" height="2" fill={eyeColor} />
      <rect x="6" y="4" width="2" height="2" fill={eyeColor} />
      <rect x="3" y="4" width="1" height="1" fill="white" opacity="0.65" />
      <rect x="7" y="4" width="1" height="1" fill="white" opacity="0.65" />
      {variant !== "default" && (
        <>
          <rect x="1" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />
          <rect x="8" y="5" width="1" height="1" fill="#f9a8d4" opacity="0.6" />
        </>
      )}
      <rect x="3" y="6" width="4" height="1" fill={S} opacity="0.5" />
      <rect x="2" y="7" width="6" height="3" fill={B} />
      <rect x="3" y="8" width="4" height="1" fill={S} opacity="0.35" />
      <rect x="0" y="7" width="2" height="2" fill={B} />
      <rect x="8" y="7" width="2" height="2" fill={B} />
      <rect x="3" y="10" width="2" height="2" fill={S} />
      <rect x="5" y="11" width="2" height="2" fill={S} />
    </svg>
  );
}

const VARIANT_BTN: Record<string, string> = {
  danger:  "rounded-md bg-[var(--state-error)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50",
  warn:    "rounded-md bg-[var(--state-warn)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50",
  default: "btn btn-primary disabled:opacity-50",
};

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warn" | "default";
}

export function ConfirmDialog({
  open, opts, onConfirm, onCancel,
}: {
  open: boolean;
  opts: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const variant = opts.variant ?? "default";
  const showMascot = variant !== "default";
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-sm p-0"
      >
        <div className="px-5 py-5">
          {showMascot && (
            <div className="mb-3 flex justify-center">
              <ConfirmMascot variant={variant} />
            </div>
          )}
          {opts.title && (
            <p className="mb-1 text-center text-base font-semibold">{opts.title}</p>
          )}
          <p className={["text-sm text-[var(--text-muted)]", showMascot ? "text-center" : ""].join(" ")}>
            {opts.message}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost"
            autoFocus
          >
            {opts.cancelLabel ?? "Скасувати"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={VARIANT_BTN[variant]}
          >
            {opts.confirmLabel ?? (variant === "danger" ? "Видалити" : "Підтвердити")}
          </button>
        </div>
      </div>
    </div>
  );
}
