"use client";

import { useEffect, useRef, useState } from "react";

export type CellOption = { id: number; label: string };

/**
 * Typeable cell picker — type a cell code (e.g. "A3") instead of scrolling a
 * dropdown. Filters options by substring; click or Enter to select.
 */
export function CellCombobox({
  cells, value, onChange, placeholder = "Комірка (напр. A3)…", emptyLabel,
}: {
  cells: CellOption[];
  value: string;                 // selected cell id as string, "" = none
  onChange: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;           // when set, offers a "— <emptyLabel> —" reset row
}) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = cells.find((c) => String(c.id) === value);
  const q = search.toLowerCase().trim();
  const filtered = q
    ? cells.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 60)
    : cells.slice(0, 60);

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

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={selected && !open ? selected.label : search}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]"
        onFocus={() => { setSearch(""); setOpen(true); }}
        onChange={(e) => {
          const v = e.target.value;
          // QR code format "CELL:{id}" — auto-select by id immediately
          const qr = v.match(/^CELL:(\d+)$/i);
          if (qr) {
            const cell = cells.find((c) => String(c.id) === qr[1]);
            if (cell) { pick(String(cell.id)); return; }
          }
          setSearch(v); setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // QR code arrived as full string before Enter
          const qr = search.match(/^CELL:(\d+)$/i);
          if (qr) {
            const cell = cells.find((c) => String(c.id) === qr[1]);
            if (cell) { pick(String(cell.id)); return; }
          }
          if (filtered.length > 0) pick(String(filtered[0].id));
        }}
      />
      {selected && (
        <button
          type="button"
          onClick={() => { onChange(""); setSearch(""); setOpen(true); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)] hover:text-[var(--text)]"
        >×</button>
      )}
      {open && (
        <div className="absolute left-0 top-full z-[80] mt-1 max-h-52 w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl">
          {emptyLabel && (
            <button type="button"
              onClick={() => pick("")}
              className="flex w-full items-center px-3 py-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
              — {emptyLabel} —
            </button>
          )}
          {filtered.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-[var(--text-faint)]">Нічого не знайдено</p>
          ) : filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(String(c.id)); }}
              className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-[var(--surface-hi)]"
            >
              <span className="font-mono">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
