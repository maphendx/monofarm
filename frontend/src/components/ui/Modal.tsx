"use client";

import { useEffect, useState } from "react";

let lockCount = 0;
let savedScrollY = 0;
let savedBodyStyle: {
  overflow: string;
  position: string;
  top: string;
  width: string;
} | null = null;

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;

    lockCount += 1;
    if (lockCount === 1) {
      savedScrollY = window.scrollY;
      savedBodyStyle = {
        overflow: document.body.style.overflow,
        position: document.body.style.position,
        top: document.body.style.top,
        width: document.body.style.width,
      };
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${savedScrollY}px`;
      document.body.style.width = "100%";
    }

    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0 && savedBodyStyle) {
        document.body.style.overflow = savedBodyStyle.overflow;
        document.body.style.position = savedBodyStyle.position;
        document.body.style.top = savedBodyStyle.top;
        document.body.style.width = savedBodyStyle.width;
        window.scrollTo(0, savedScrollY);
        savedBodyStyle = null;
      }
    };
  }, [active]);
}

const SIZE_CLS: Record<string, string> = {
  md:    "max-w-md",
  lg:    "max-w-lg",
  xl:    "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
};

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl";
}) {
  useBodyScrollLock(open);

  // Keep the panel mounted through the exit animation before unmounting.
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) { setRender(true); return; }
    if (!render) return;
    const t = setTimeout(() => setRender(false), 140);
    return () => clearTimeout(t);
  }, [open, render]);
  const closing = !open && render;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 ${closing ? "overlay-out" : "overlay-in"}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`modal-panel p-0 w-full flex flex-col max-h-[90vh] ${SIZE_CLS[size] ?? "max-w-md"} ${closing ? "modal-out" : ""}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
