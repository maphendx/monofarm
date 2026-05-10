"use client";

import {
  flagLabel,
  kindLabel,
  printerTone,
  stateEmoji,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer } from "@/lib/types";

const TONE_BORDER: Record<string, string> = {
  ok: "border-emerald-500/60",
  warn: "border-amber-500/60",
  bad: "border-red-500/60",
  idle: "border-neutral-300 dark:border-neutral-700",
  muted: "border-neutral-200 dark:border-neutral-800 opacity-70",
};

const TONE_DOT: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  idle: "bg-neutral-400",
  muted: "bg-neutral-300",
};

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

export function PrinterCard({
  printer,
  onClick,
}: {
  printer: Printer;
  onClick?: (p: Printer) => void;
}) {
  const tone = printerTone(printer);
  const eta = formatEta(printer.eta_minutes);

  return (
    <button
      type="button"
      onClick={() => onClick?.(printer)}
      className={
        "flex flex-col gap-2 rounded-xl border-2 bg-white p-4 text-left shadow-sm transition hover:shadow-md dark:bg-neutral-900 " +
        TONE_BORDER[tone]
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{printer.name}</div>
          <div className="text-xs text-neutral-500">
            {kindLabel(printer.kind)}
          </div>
        </div>
        <span className={`mt-1 size-2.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-lg leading-none">{stateEmoji(printer.state)}</span>
        <span>{stateLabel(printer.state)}</span>
      </div>

      {printer.flags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      {(printer.job || eta) && (
        <div className="border-t border-neutral-100 pt-2 text-xs text-neutral-500 dark:border-neutral-800">
          {printer.job && <div className="truncate">📦 {printer.job}</div>}
          {eta && <div>⏱ {eta}</div>}
        </div>
      )}
    </button>
  );
}
