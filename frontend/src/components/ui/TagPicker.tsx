"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { TagBadge, type Tag } from "./TagBadge";

const KIND_DEFAULTS: Record<string, string> = {
  nozzle: "#6366f1",
  material: "#0ea5e9",
  bed_type: "#f59e0b",
  custom: "#6b7280",
};

interface Props {
  available: Tag[];
  selected: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  onCreateTag?: () => void;
}

export function TagPicker({ available, selected, onChange, disabled, onCreateTag }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedTags = available.filter((t) => selected.includes(t.id));

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="relative inline-flex flex-wrap items-center gap-1" ref={ref}>
      {selectedTags.map((tag) => (
        <TagBadge
          key={tag.id}
          tag={tag}
          onRemove={disabled ? undefined : () => toggle(tag.id)}
        />
      ))}

      {!disabled && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[var(--border-strong)] text-[var(--text-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
          title="Додати тег"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}

      {open && (
        <div className="anim-menu absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl">
          {available.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--text-muted)]">Тегів немає</p>
          ) : (
            <ul className="max-h-52 overflow-y-auto py-1">
              {available.map((tag) => {
                const isOn = selected.includes(tag.id);
                const dot = tag.color ?? KIND_DEFAULTS[tag.kind] ?? "#6b7280";
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--surface-hi)] transition-colors"
                      onClick={() => toggle(tag.id)}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
                      <span className="flex-1 text-[var(--text)]">{tag.display || tag.label}</span>
                      {isOn && <Check className="h-3 w-3 shrink-0 text-[var(--accent)]" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {onCreateTag && (
            <div className="border-t border-[var(--border)] p-1.5">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface-hi)] transition-colors"
                onClick={() => { setOpen(false); onCreateTag(); }}
              >
                <Plus className="h-3 w-3" /> Створити тег
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
