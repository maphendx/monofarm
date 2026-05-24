"use client";

import { useState } from "react";

import { FilamentSwatches } from "@/components/FilamentSwatches";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { StateIcon } from "@/components/StateIcon";
import type { Printer } from "@/lib/types";

const TONE_LEFT_COLOR: Record<string, string> = {
  printing: "#3b82f6",
  ok:       "#10b981",
  warn:     "#f59e0b",
  bad:      "#ef4444",
  idle:     "transparent",
  muted:    "transparent",
};

const TONE_STATE: Record<string, string> = {
  printing: "text-blue-600 dark:text-blue-400",
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  idle: "text-neutral-500",
  muted: "text-neutral-400",
};

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
}


function SettingsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

export function PrinterCard({
  printer,
  onClick,
  onSettings,
  onUpdated,
  onPrint,
}: {
  printer: Printer;
  onClick?: (p: Printer) => void;
  onSettings?: (p: Printer) => void;
  onUpdated?: (p: Printer) => void;
  onPrint?: (p: Printer) => void;
}) {
  const user = useUser();
  const tone = printerTone(printer);
  const eta = formatEta(printer.eta_minutes);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isIdle = printer.state === "idle";
  const isOperational = printer.state === "operational" || printer.state === "awaiting_bed_clear";
  const hasMoonraker = !!printer.moonraker_url;
  const canEdit = user.role === "admin" || user.role === "operator";
  const isActionable = (isPrinting || isPaused || isOperational || isIdle) && canEdit;
  const showProgress = isPrinting && printer.progress_pct != null;

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (busy) return;
    setConfirmCancel(false);
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-printer-id={printer.id}
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(printer)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(printer)}
      className={[
        "group relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-md border p-3 pl-4",
        "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900",
        tone === "muted" ? "opacity-50" : "",
        "text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/60",
      ].join(" ")}
      style={{ borderLeftWidth: 3, borderLeftColor: TONE_LEFT_COLOR[tone] }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{printer.name}</div>
          <div className="text-xs text-neutral-400">{kindLabel(printer.kind)}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onSettings && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSettings(printer); }}
              title="Налаштування"
              className="rounded p-0.5 text-neutral-300 opacity-0 transition hover:text-neutral-600 group-hover:opacity-100 dark:text-neutral-600 dark:hover:text-neutral-300"
              tabIndex={-1}
            >
              <SettingsIcon />
            </button>
          )}
          <StateIcon state={printer.state} size={14} />
        </div>
      </div>

      {/* State label */}
      <div className={`text-[11px] font-medium ${TONE_STATE[tone]}`}>
        {stateLabel(printer.state)}
      </div>

      {/* Error — compact single line */}
      {printer.error_msg && (
        <div className="truncate rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400" title={printer.error_msg}>
          {printer.error_msg}
        </div>
      )}
      {printer.state === "error" && !printer.error_msg && (
        <div className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
          Невідома помилка
        </div>
      )}

      {/* Filament dots */}
      {printer.loaded_filaments?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.loaded_filaments.map((s, i) => {
            const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
            return (
              <span
                key={i}
                title={`#${i + 1} ${s.color_name ?? s.type}${s.brand ? ` · ${s.brand}` : ""}`}
                className="size-3 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      )}

      {printer.current_filament_meta && (
        <FilamentSwatches meta={printer.current_filament_meta} size={9} />
      )}

      {/* Flags */}
      {printer.flags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded bg-amber-100 px-1 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      {/* Job + ETA */}
      {(printer.job || eta) && (
        <div className="border-t border-neutral-100 pt-1.5 text-xs text-neutral-400 dark:border-neutral-800">
          {printer.job && <div className="truncate">{printer.job}</div>}
          {eta && <div className="tabular-nums">{eta} залишилось</div>}
        </div>
      )}

      {/* Temps */}
      {(printer.extruder_temp != null || printer.bed_temp != null) && (
        <div className="flex gap-2 text-xs text-neutral-400 tabular-nums">
          {printer.extruder_temp != null && (
            <span title="Сопло">
              {Math.round(printer.extruder_temp)}°
              {printer.extruder_target ? `→${Math.round(printer.extruder_target)}°` : ""}
            </span>
          )}
          {printer.bed_temp != null && (
            <span title="Стіл">
              {Math.round(printer.bed_temp)}°
              {printer.bed_target ? `→${Math.round(printer.bed_target)}°` : ""}
            </span>
          )}
        </div>
      )}

      {/* Progress bar */}
      {showProgress && (
        <div className="h-[3px] overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-1000 ease-linear"
            style={{ width: `${printer.progress_pct}%` }}
          />
        </div>
      )}

      {/* Action strip */}
      {isActionable && (
        <div className="mt-0.5 border-t border-neutral-100 pt-1.5 dark:border-neutral-800">
          <div className="flex flex-wrap gap-1">
            {isIdle && onPrint && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPrint(printer); }}
                className="flex-1 rounded-md bg-cyan-600 py-1 text-xs font-medium font-mono tracking-wide text-white transition hover:bg-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-400 dark:hover:bg-cyan-500/25"
              >
                ▶ Друк
              </button>
            )}
            {isOperational && (
              <button
                type="button"
                onClick={(e) => act(e, "clear-bed")}
                disabled={busy !== null}
                className="flex-1 rounded-md bg-emerald-500 py-1 text-xs font-medium font-mono tracking-wide text-white transition hover:bg-emerald-600 disabled:opacity-40 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/25"
              >
                {busy === "clear-bed" ? "…" : "Стіл очищено"}
              </button>
            )}
            {isPrinting && (
              <button
                type="button"
                onClick={(e) => act(e, "pause")}
                disabled={busy !== null}
                className="flex-1 rounded-md bg-amber-500 py-1 text-xs font-medium font-mono tracking-wide text-black transition hover:bg-amber-600 disabled:opacity-40 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/25"
              >
                {busy === "pause" ? "…" : "Пауза"}
              </button>
            )}
            {isPaused && (
              <button
                type="button"
                onClick={(e) => act(e, "resume")}
                disabled={busy !== null}
                className="flex-1 rounded-md bg-emerald-500 py-1 text-xs font-medium font-mono tracking-wide text-white transition hover:bg-emerald-600 disabled:opacity-40 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/25"
              >
                {busy === "resume" ? "…" : "Продовж."}
              </button>
            )}
            {(isPrinting || isPaused) && (
              confirmCancel ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "cancel")}
                    disabled={busy !== null}
                    className="flex-1 rounded-md bg-red-500 py-1 text-xs font-medium font-mono tracking-wide text-white hover:bg-red-600 disabled:opacity-40 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/25"
                  >
                    {busy === "cancel" ? "…" : "Підтвердити"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmCancel(false); }}
                    className="rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                  >
                    Ні
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmCancel(true); }}
                  disabled={busy !== null}
                  className="flex-1 rounded-md bg-red-500 py-1 text-xs font-medium font-mono tracking-wide text-white transition hover:bg-red-600 disabled:opacity-40 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/25"
                >
                  Стоп
                </button>
              )
            )}
            {isPrinting && hasMoonraker && (
              <button
                type="button"
                onClick={(e) => act(e, "skip-object")}
                disabled={busy !== null}
                title="Пропустити об'єкт ([exclude_object] в printer.cfg)"
                className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium font-mono tracking-wide text-neutral-500 transition hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              >
                {busy === "skip-object" ? "…" : "Скіп"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
