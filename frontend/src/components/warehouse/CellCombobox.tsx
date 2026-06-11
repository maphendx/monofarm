"use client";

import { useEffect, useRef, useState } from "react";
import { matchTokens } from "@/lib/search";

export type CellOption = { id: number; label: string; zone?: string };

/**
 * Typeable cell picker — type a cell code (e.g. "A3") or scan a QR code
 * (format "CELL:{id}") to select. Groups options by zone when no search term.
 */
export function CellCombobox({
  cells, value, onChange, placeholder = "Комірка (напр. A3)…", emptyLabel,
}: {
  cells: CellOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
}) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = cells.find((c) => String(c.id) === value);
  const q = search.trim();

  const filtered: CellOption[] = q
    ? cells.filter((c) => matchTokens(`${c.label} ${c.zone ?? ""}`, q))
    : cells;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(id: string) {
    onChange(id);
    setSearch("");
    setOpen(false);
  }

  function handleChange(v: string) {
    // QR code format "CELL:{id}" — auto-select immediately
    const qr = v.match(/^CELL:(\d+)$/i);
    if (qr) {
      const cell = cells.find((c) => String(c.id) === qr[1]);
      if (cell) { pick(String(cell.id)); return; }
    }
    setSearch(v);
    setOpen(true);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // QR code may have arrived character-by-character before Enter
    const qr = search.match(/^CELL:(\d+)$/i);
    if (qr) {
      const cell = cells.find((c) => String(c.id) === qr[1]);
      if (cell) { pick(String(cell.id)); return; }
    }
    if (filtered.length > 0) pick(String(filtered[0].id));
  }

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={selected && !open ? `${selected.zone ? selected.zone + " " : ""}${selected.label}` : search}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]"
        onFocus={() => { setSearch(""); setOpen(true); }}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {selected && (
        <button
          type="button"
          onClick={() => { onChange(""); setSearch(""); setOpen(true); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)] hover:text-[var(--text)]"
        >×</button>
      )}
      {open && (
        <div className="absolute left-0 top-full z-[80] mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl">
          {emptyLabel && (
            <button type="button" onClick={() => pick("")}
              className="flex w-full items-center px-3 py-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
              — {emptyLabel} —
            </button>
          )}
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : (
            filtered.map((c) => (
              <button key={c.id} type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(String(c.id)); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]">
                {c.zone && (
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{c.zone}</span>
                )}
                {c.zone && <span className="text-[var(--border-strong)]">·</span>}
                <span className="font-mono font-medium">{c.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
