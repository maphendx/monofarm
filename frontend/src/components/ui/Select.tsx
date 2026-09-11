"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

interface Option<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  /** Accessible name for the trigger button (announced by screen readers). */
  ariaLabel?: string;
  className?: string;
}

/** Custom dropdown styled like the rest of the UI — replaces native <select>. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function openMenu() {
    setHighlighted(Math.max(0, options.findIndex((o) => o.id === value)));
    setOpen(true);
  }

  function select(id: T) {
    onChange(id);
    setOpen(false);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlighted(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlighted(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[highlighted];
      if (opt) select(opt.id);
    }
  }

  const current = options.find((o) => o.id === value);

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={[
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm outline-none transition-colors",
          open
            ? "border-[var(--border-strong)] bg-[var(--surface-hi)] text-[var(--text)]"
            : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--border-strong)]",
        ].join(" ")}
      >
        {current?.label ?? value}
        <ChevronDown
          size={14}
          className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="anim-menu absolute left-0 top-full z-50 mt-1 min-w-full max-h-64 overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-1 shadow-xl"
        >
          {options.map((o, i) => {
            const active = o.id === value;
            return (
              <li key={o.id} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => select(o.id)}
                  className={[
                    "flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                    i === highlighted ? "bg-[var(--surface-hi)] text-[var(--text)]" : "text-[var(--text-muted)]",
                  ].join(" ")}
                >
                  <span className="min-w-0 flex-1">{o.label}</span>
                  {active && <Check size={14} className="shrink-0 text-[var(--accent)]" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
