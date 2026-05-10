"use client";

import type { FilamentMeta } from "@/lib/types";

function parseColor(c: string): string {
  // Slicers usually emit "#RRGGBB" but can also use 8-digit (#RRGGBBAA) or names.
  if (!c) return "#999";
  return c.startsWith("#") ? c.slice(0, 7) : c;
}

export function FilamentSwatches({
  meta,
  size = 12,
  showLabel = false,
}: {
  meta: FilamentMeta | null | undefined;
  size?: number;
  showLabel?: boolean;
}) {
  const colors = meta?.colors ?? [];
  const types = meta?.types ?? [];
  if (colors.length === 0 && types.length === 0) return null;

  const max = Math.max(colors.length, types.length);
  const swatches: { color: string; type: string | null; grams: number | null }[] = [];
  for (let i = 0; i < max; i++) {
    swatches.push({
      color: parseColor(colors[i] ?? "#888888"),
      type: types[i] ?? null,
      grams: meta?.used_g?.[i] ?? null,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {swatches.map((s, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] dark:border-neutral-700 dark:bg-neutral-900"
          title={`${s.type ?? ""}${s.grams ? ` · ${s.grams} г` : ""}`}
        >
          <span
            className="rounded-full ring-1 ring-black/10"
            style={{
              backgroundColor: s.color,
              width: size,
              height: size,
            }}
          />
          {showLabel && (
            <span className="text-neutral-600 dark:text-neutral-400">
              {s.type ?? ""}
              {s.grams ? ` ${s.grams}г` : ""}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
