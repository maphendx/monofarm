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
  nozzle: "#6366f1",   // indigo
  material: "#0ea5e9", // sky
  bed_type: "#f59e0b", // amber
  custom: "#6b7280",   // gray
};

function contrastColor(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#111" : "#fff";
}

interface Props {
  tag: Tag;
  onRemove?: () => void;
  size?: "sm" | "md";
}

export function TagBadge({ tag, onRemove, size = "sm" }: Props) {
  const bg = tag.color ?? KIND_DEFAULTS[tag.kind] ?? "#6b7280";
  const fg = contrastColor(bg);
  const py = size === "sm" ? "py-0.5" : "py-1";
  const px = size === "sm" ? "px-2" : "px-3";
  const text = size === "sm" ? "text-xs" : "text-sm";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${py} ${px} ${text}`}
      style={{ backgroundColor: bg, color: fg }}
    >
      {tag.display || tag.label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded-full hover:opacity-70 transition-opacity"
          aria-label="Remove tag"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
