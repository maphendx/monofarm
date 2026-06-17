"use client";

import { X } from "lucide-react";

export interface Tag {
  id: number;
  kind: "nozzle" | "material" | "bed_type" | "custom";
  label?: string | null;
  color?: string | null;
  meta?: Record<string, unknown> | null;
  display: string;
}

const KIND_DEFAULTS: Record<string, string> = {
  nozzle: "#6366f1",
  material: "#0ea5e9",
  bed_type: "#f59e0b",
  custom: "#6b7280",
};

interface Props {
  tag: Tag;
  onRemove?: () => void;
}

export function TagBadge({ tag, onRemove }: Props) {
  const dot = tag.color ?? KIND_DEFAULTS[tag.kind] ?? "#6b7280";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-xs font-medium text-[var(--text)]">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: dot }}
      />
      {tag.display || tag.label}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 rounded-full text-[var(--text-faint)] hover:text-[var(--state-error)] transition-colors"
          aria-label="Remove"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
