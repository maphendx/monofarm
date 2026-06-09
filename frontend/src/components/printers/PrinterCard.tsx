"use client";

import { useState } from "react";
import { toast } from "sonner";

import { SlotStrip } from "@/components/printers/SlotStrip";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { StateIcon } from "@/components/printers/StateIcon";
import type { Printer } from "@/lib/types";

// Maps printerTone → .printer-card state modifier class (also used for .pc-status)
const TONE_CLASS: Record<string, string> = {
  printing: "printing",
  ok:       "ok",
  warn:     "warn",
  bad:      "error",
  idle:     "",
  muted:    "muted",
};

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min}хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}г ${m}хв` : `${h}год`;
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
  const [confirmClearBed, setConfirmClearBed] = useState(false);

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (busy) return;
    setConfirmCancel(false);
    setConfirmClearBed(false);
    setBusy(action);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      const list = await api<Printer[]>("/api/printers");
      const updated = list.find((p) => p.id === printer.id);
      if (updated) onUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  const toneClass = TONE_CLASS[tone];

  return (
    <div
      data-printer-id={printer.id}
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(printer)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(printer)}
      className={["printer-card group cursor-pointer text-left", toneClass, tone === "muted" ? "opacity-60" : ""].join(" ")}
    >
      {/* Header */}
      <div className="pc-head">
        <div className="min-w-0 flex-1">
          <div className="pc-id truncate">{printer.name}</div>
          <div className="pc-model">{kindLabel(printer.kind)}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onSettings && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSettings(printer); }}
              title="Налаштування"
              className="rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:text-[var(--text)] group-hover:opacity-100"
              tabIndex={-1}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h8.4"/><path d="M16.6 7H20"/><circle cx="14.5" cy="7" r="2.1"/>
                <path d="M4 17h3.4"/><path d="M11.6 17H20"/><circle cx="9.5" cy="17" r="2.1"/>
              </svg>
            </button>
          )}
          <StateIcon state={printer.state} size={14} />
        </div>
      </div>

      {/* State label */}
      <div className={["pc-status", toneClass].filter(Boolean).join(" ")}>
        {stateLabel(printer.state)}
      </div>

      {/* Error — compact single line */}
      {printer.error_msg && (
        <div className="truncate rounded px-1.5 py-0.5 text-xs bg-[rgba(239,68,68,.10)] text-[var(--state-error)]" title={printer.error_msg}>
          {printer.error_msg}
        </div>
      )}
      {printer.state === "error" && !printer.error_msg && (
        <div className="rounded px-1.5 py-0.5 text-xs bg-[rgba(239,68,68,.10)] text-[var(--state-error)]">
          Невідома помилка
        </div>
      )}

      {/* Slot strip — all printer kinds; falls back to loaded_filaments dots for Bambu */}
      {printer.slots && printer.slots.length > 0 ? (
        <SlotStrip slots={printer.slots} kind={printer.kind} />
      ) : printer.kind !== "snapmaker_u1" && printer.loaded_filaments?.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {printer.loaded_filaments.map((s, i) => {
            const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
            return (
              <span
                key={i}
                title={`#${i + 1} ${s.color_name ?? s.type}${s.brand ? ` · ${s.brand}` : ""}`}
                className="size-3 rounded-full ring-1 ring-[var(--border-strong)]"
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      ) : null}

      {/* Flags */}
      {printer.flags?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {printer.flags.map((f) => (
            <span
              key={f}
              className="rounded px-1 py-0.5 text-xs bg-[rgba(245,158,11,.10)] text-[var(--state-warn)]"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      {/* Job + ETA */}
      {(printer.job || eta) && (
        <div className="border-t border-[var(--border)] pt-1.5">
          {printer.job && <div className="pc-file truncate">{printer.job}</div>}
          {eta && <div className="pc-eta">{eta} залишилось</div>}
        </div>
      )}

      {/* Temps */}
      {(printer.extruder_temp != null || printer.bed_temp != null) && (
        <div className="pc-temps flex gap-2">
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
        <div className="progress">
          <div
            className="progress-fill transition-[width] duration-1000 ease-linear"
            style={{ width: `${printer.progress_pct}%` }}
          />
        </div>
      )}

      {/* Action strip */}
      {isActionable && (
        <div className="border-t border-[var(--border)] pt-1.5">
          <div className="pc-actions flex-wrap">
            {isIdle && onPrint && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPrint(printer); }}
                className="btn btn-primary btn-sm flex-1"
              >
                ▶ Друк
              </button>
            )}
            {isOperational && (
              confirmClearBed ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "clear-bed")}
                    disabled={busy !== null}
                    className="btn btn-sm flex-1 border-[rgba(34,197,94,.20)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40"
                  >
                    {busy === "clear-bed" ? "…" : "Підтвердити"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmClearBed(false); }}
                    className="btn btn-sm disabled:opacity-40"
                  >
                    Ні
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmClearBed(true); }}
                  disabled={busy !== null}
                  className="btn btn-sm flex-1 border-[rgba(34,197,94,.20)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)] hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40"
                >
                  Стіл очищено
                </button>
              )
            )}
            {isPrinting && (
              <button
                type="button"
                onClick={(e) => act(e, "pause")}
                disabled={busy !== null}
                className="btn btn-warn btn-sm flex-1 disabled:opacity-40"
              >
                {busy === "pause" ? "…" : "Пауза"}
              </button>
            )}
            {isPaused && (
              <button
                type="button"
                onClick={(e) => act(e, "resume")}
                disabled={busy !== null}
                className="btn btn-primary btn-sm flex-1 disabled:opacity-40"
              >
                {busy === "resume" ? "…" : "▶ Продовж."}
              </button>
            )}
            {(isPrinting || isPaused) && (
              confirmCancel ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => act(e, "cancel")}
                    disabled={busy !== null}
                    className="btn btn-danger btn-sm flex-1 disabled:opacity-40"
                  >
                    {busy === "cancel" ? "…" : "Підтвердити"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setConfirmCancel(false); }}
                    className="btn btn-sm disabled:opacity-40"
                  >
                    Ні
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmCancel(true); }}
                  disabled={busy !== null}
                  className="btn btn-danger btn-sm flex-1 disabled:opacity-40"
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
                className="btn btn-sm text-[var(--text-muted)] disabled:opacity-40"
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
