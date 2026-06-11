"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";

export type ColDef = {
  key:       string;
  label:     string;
  required?: boolean;
};

// ── persistence ────────────────────────────────────────────────────────────────

function readHidden(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(`col-vis:${storageKey}`);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function readOrder(storageKey: string, cols: ColDef[]): string[] {
  if (typeof window === "undefined") return cols.map((c) => c.key);
  try {
    const raw = localStorage.getItem(`col-order:${storageKey}`);
    if (raw) {
      const saved = JSON.parse(raw) as string[];
      // Keep saved order, append any new cols not yet saved
      const known = new Set(saved);
      const extra  = cols.map((c) => c.key).filter((k) => !known.has(k));
      return [...saved.filter((k) => cols.some((c) => c.key === k)), ...extra];
    }
  } catch {}
  return cols.map((c) => c.key);
}

// ── hook ───────────────────────────────────────────────────────────────────────

export function useColumnVisibility(storageKey: string, cols: ColDef[]) {
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(storageKey));
  const [order,  setOrderState] = useState<string[]>(() => readOrder(storageKey, cols));

  function isVisible(key: string) { return !hidden.has(key); }

  function setVisibility(next: Set<string>) {
    setHidden(next);
    try { localStorage.setItem(`col-vis:${storageKey}`, JSON.stringify([...next])); } catch {}
  }

  function setOrder(next: string[]) {
    setOrderState(next);
    try { localStorage.setItem(`col-order:${storageKey}`, JSON.stringify(next)); } catch {}
  }

  function reset() {
    setVisibility(new Set());
    setOrder(cols.map((c) => c.key));
  }

  const orderedCols: ColDef[] = order
    .map((k) => cols.find((c) => c.key === k))
    .filter(Boolean) as ColDef[];

  const visibleCount = orderedCols.filter((c) => !hidden.has(c.key)).length;

  return { isVisible, hidden, setVisibility, setOrder, reset, cols, orderedCols, visibleCount };
}


// ── Modal ──────────────────────────────────────────────────────────────────────

export function ColumnSettingsModal({
  open, onClose, cols, hidden, setVisibility, orderedCols, setOrder,
}: {
  open:          boolean;
  onClose:       () => void;
  cols:          ColDef[];
  hidden:        Set<string>;
  setVisibility: (h: Set<string>) => void;
  orderedCols:   ColDef[];
  setOrder:      (o: string[]) => void;
}) {
  const [draftHidden, setDraftHidden] = useState<Set<string>>(new Set(hidden));
  const [draftOrder,  setDraftOrder]  = useState<string[]>(orderedCols.map((c) => c.key));
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setDraftHidden(new Set(hidden));
      setDraftOrder(orderedCols.map((c) => c.key));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(key: string) {
    const next = new Set(draftHidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    setDraftHidden(next);
  }

  function apply() {
    setVisibility(draftHidden);
    setOrder(draftOrder);
    onClose();
  }

  function reset() {
    setDraftHidden(new Set());
    setDraftOrder(cols.map((c) => c.key));
  }

  // Drag handlers
  function onDragStart(i: number) { dragIdx.current = i; }
  function onDragOver(e: React.DragEvent, i: number) { e.preventDefault(); setOverIdx(i); }
  function onDragLeave() { setOverIdx(null); }
  function onDrop(i: number) {
    const from = dragIdx.current;
    if (from === null || from === i) { setOverIdx(null); return; }
    const next = [...draftOrder];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    setDraftOrder(next);
    dragIdx.current = null;
    setOverIdx(null);
  }

  const orderedDraft = draftOrder
    .map((k) => cols.find((c) => c.key === k))
    .filter(Boolean) as ColDef[];

  return (
    <Modal open={open} onClose={onClose} title="Налаштування таблиці">
      <div className="space-y-0.5 py-1">
        {orderedDraft.map((col, i) => {
          const visible  = !draftHidden.has(col.key);
          const disabled = !!col.required;
          const isOver   = overIdx === i;
          return (
            <div
              key={col.key}
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={(e) => onDragOver(e, i)}
              onDragLeave={onDragLeave}
              onDrop={() => onDrop(i)}
              className={[
                "flex cursor-grab items-center justify-between rounded-lg px-3 py-2 transition-colors active:cursor-grabbing select-none",
                isOver   ? "bg-[var(--accent)]/10 outline outline-1 outline-[var(--accent)]" : "hover:bg-[var(--surface-hi)]",
                disabled ? "opacity-50" : "",
              ].join(" ")}
            >
              <div className="flex items-center gap-3">
                {/* Drag handle */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-[var(--text-faint)]">
                  <circle cx="9"  cy="5"  r="1.5"/><circle cx="15" cy="5"  r="1.5"/>
                  <circle cx="9"  cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
                  <circle cx="9"  cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
                </svg>
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={disabled}
                  onChange={() => !disabled && toggle(col.key)}
                  onClick={(e) => e.stopPropagation()}
                  className="size-4 accent-[var(--accent)] cursor-pointer"
                />
                <span className="text-sm">{col.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-4">
        <button onClick={reset} className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
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
    <button onClick={onClick} className="btn btn-ghost btn-sm" title="Налаштування таблиці">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  );
}
