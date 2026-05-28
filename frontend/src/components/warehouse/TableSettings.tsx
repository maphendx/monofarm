"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";

export type ColDef = {
  key:       string;
  label:     string;
  required?: boolean;
};

function readHidden(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(`col-vis:${storageKey}`);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

export function useColumnVisibility(storageKey: string, cols: ColDef[]) {
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(storageKey));

  function isVisible(key: string) { return !hidden.has(key); }

  function setVisibility(next: Set<string>) {
    setHidden(next);
    try { localStorage.setItem(`col-vis:${storageKey}`, JSON.stringify([...next])); } catch {}
  }

  function reset() { setVisibility(new Set()); }

  const visibleCount = cols.filter((c) => !hidden.has(c.key)).length;

  return { isVisible, hidden, setVisibility, reset, cols, visibleCount };
}

export type ColVisibility = ReturnType<typeof useColumnVisibility>;

// ── Modal ──────────────────────────────────────────────────────────────────────

export function ColumnSettingsModal({
  open, onClose, cols, hidden, setVisibility,
}: {
  open:          boolean;
  onClose:       () => void;
  cols:          ColDef[];
  hidden:        Set<string>;
  setVisibility: (h: Set<string>) => void;
}) {
  const [draft, setDraft] = useState<Set<string>>(new Set(hidden));

  useEffect(() => { if (open) setDraft(new Set(hidden)); }, [open, hidden]);

  function toggle(key: string) {
    const next = new Set(draft);
    if (next.has(key)) next.delete(key); else next.add(key);
    setDraft(next);
  }

  function apply() { setVisibility(draft); onClose(); }
  function reset()  { setDraft(new Set()); }

  return (
    <Modal open={open} onClose={onClose} title="Налаштування таблиці">
      <div className="space-y-0.5 py-1">
        {cols.map((col) => {
          const visible  = !draft.has(col.key);
          const disabled = !!col.required;
          return (
            <label
              key={col.key}
              className={[
                "flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 transition-colors",
                disabled ? "cursor-default opacity-50" : "hover:bg-[var(--surface-hi)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={disabled}
                  onChange={() => !disabled && toggle(col.key)}
                  className="size-4 accent-[var(--accent)]"
                />
                <span className="text-sm">{col.label}</span>
              </div>
              <span className="select-none text-xs text-[var(--text-faint)]">↕</span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-4">
        <button
          onClick={reset}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Скинути налаштування
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn btn-ghost btn-sm">Скасувати</button>
          <button onClick={apply}   className="btn btn-primary btn-sm">Змінити</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Gear button ────────────────────────────────────────────────────────────────

export function TableSettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn btn-ghost btn-sm"
      title="Налаштування таблиці"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  );
}
