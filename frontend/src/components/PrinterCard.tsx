"use client";

import Link from "next/link";
import { useState } from "react";

import { FilamentSwatches } from "@/components/FilamentSwatches";
import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateEmoji,
  stateLabel,
} from "@/lib/printerLabels";
import type { Printer } from "@/lib/types";

const TONE_BORDER: Record<string, string> = {
  printing: "border-blue-500/70",
  ok: "border-emerald-500/60",
  warn: "border-amber-500/60",
  bad: "border-red-500/60",
  idle: "border-neutral-300 dark:border-neutral-700",
  muted: "border-neutral-200 dark:border-neutral-800 opacity-70",
};

const TONE_DOT: Record<string, string> = {
  printing: "bg-blue-500",
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
  onUpdated,
}: {
  printer: Printer;
  onClick?: (p: Printer) => void;
  onUpdated?: (p: Printer) => void;
}) {
  const user = useUser();
  const tone = printerTone(printer);
  const eta = formatEta(printer.eta_minutes);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const needsBedClear = printer.state === "awaiting_bed_clear";
  const isSimplyPrint = printer.kind === "simplyprint";
  const isBambu = printer.kind === "bambu";
  const hasMoonraker = !!printer.moonraker_url;
  const hasLiveSource = hasMoonraker || isSimplyPrint || isBambu;
  const canEdit = user.role === "admin" || user.role === "operator";
  const isActionable = (isPrinting || isPaused || needsBedClear) && canEdit;
  const showProgress = isPrinting && printer.progress_pct != null;

  const [busy, setBusy] = useState<string | null>(null);

  async function act(e: React.MouseEvent, action: string) {
    e.stopPropagation();
    if (busy) return;
    if (action === "cancel" && !confirm("Скасувати поточний друк?")) return;
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
    // outer div is the group — grows on hover
    <div
      data-printer-id={printer.id}
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(printer)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(printer)}
      className={[
        "group flex cursor-pointer flex-col gap-2 rounded-xl border-2 bg-white p-4",
        "text-left shadow-sm transition-shadow hover:shadow-md",
        "dark:bg-neutral-900",
        TONE_BORDER[tone],
      ].join(" ")}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{printer.name}</div>
          <div className="text-xs text-neutral-500">{kindLabel(printer.kind)}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            href={`/printers/${printer.id}`}
            onClick={(e) => e.stopPropagation()}
            title="Відкрити сторінку принтера"
            className="rounded p-0.5 text-neutral-400 opacity-0 transition hover:text-neutral-700 group-hover:opacity-100 dark:hover:text-neutral-200"
            tabIndex={-1}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 10L10 2M10 2H6M10 2V6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <span className={`mt-0.5 size-2.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        </div>
      </div>

      {/* state */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-lg leading-none">{stateEmoji(printer.state)}</span>
        <span>{stateLabel(printer.state)}</span>
      </div>

      {/* loaded filaments — compact colour dots */}
      {printer.loaded_filaments?.length > 0 && (
        <div className="flex gap-1.5">
          {printer.loaded_filaments.map((s, i) => {
            const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
            return (
              <span
                key={i}
                title={`#${i + 1} ${s.color_name ?? s.type}${s.brand ? ` · ${s.brand}` : ""}`}
                className="size-4 rounded-full ring-1 ring-black/15 dark:ring-white/15"
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      )}

      {printer.current_filament_meta && (
        <FilamentSwatches meta={printer.current_filament_meta} size={10} />
      )}

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

      {(printer.extruder_temp != null || printer.bed_temp != null) && (
        <div className="flex gap-2 border-t border-neutral-100 pt-2 text-[11px] text-neutral-500 dark:border-neutral-800">
          {printer.extruder_temp != null && (
            <span title="Сопло">
              🌡{Math.round(printer.extruder_temp)}°
              {printer.extruder_target ? `/${Math.round(printer.extruder_target)}°` : ""}
            </span>
          )}
          {printer.bed_temp != null && (
            <span title="Стіл">
              ▣{Math.round(printer.bed_temp)}°
              {printer.bed_target ? `/${Math.round(printer.bed_target)}°` : ""}
            </span>
          )}
        </div>
      )}

      {/* progress bar — thin strip, always last before action strip */}
      {showProgress && (
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-1000 ease-linear"
            style={{ width: `${printer.progress_pct}%` }}
          />
        </div>
      )}

      {/* ── action strip — always visible when actionable ── */}
      {isActionable && (
        <div>
          <div className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <div className="flex flex-wrap gap-1.5">
              {/* Bed clear — shown when awaiting_bed_clear (SP only) */}
              {needsBedClear && isSimplyPrint && (
                <button
                  type="button"
                  onClick={(e) => act(e, "clear-bed")}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-emerald-500/15 py-1.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-500/30 disabled:opacity-40 dark:text-emerald-300"
                >
                  {busy === "clear-bed" ? "…" : "✓ Стіл очищено"}
                </button>
              )}

              {isPrinting && (
                <button
                  type="button"
                  onClick={(e) => act(e, "pause")}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-amber-500/15 py-1.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-500/30 disabled:opacity-40 dark:text-amber-300"
                >
                  {busy === "pause" ? "…" : "⏸ Пауза"}
                </button>
              )}

              {isPaused && (
                <button
                  type="button"
                  onClick={(e) => act(e, "resume")}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-emerald-500/15 py-1.5 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-500/30 disabled:opacity-40 dark:text-emerald-300"
                >
                  {busy === "resume" ? "…" : "▶ Продовж."}
                </button>
              )}

              {(isPrinting || isPaused) && (
                <button
                  type="button"
                  onClick={(e) => act(e, "cancel")}
                  disabled={busy !== null}
                  className="flex-1 rounded-lg bg-red-500/15 py-1.5 text-[11px] font-medium text-red-700 transition hover:bg-red-500/30 disabled:opacity-40 dark:text-red-300"
                >
                  {busy === "cancel" ? "…" : "✕ Стоп"}
                </button>
              )}

              {/* Skip object — Moonraker/Klipper only; SP requires object IDs */}
              {isPrinting && hasMoonraker && (
                <button
                  type="button"
                  onClick={(e) => act(e, "skip-object")}
                  disabled={busy !== null}
                  title="Пропустити поточний об'єкт (потребує [exclude_object] в printer.cfg)"
                  className="flex-1 rounded-lg bg-neutral-500/10 py-1.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-500/20 disabled:opacity-40 dark:text-neutral-300"
                >
                  {busy === "skip-object" ? "…" : "⏭ Скіп"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
