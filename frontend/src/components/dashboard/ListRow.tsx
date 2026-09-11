"use client";

import { useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";

import {
  formatEtaShort,
  formatFinishTime,
  getPrinterCardTone,
  printerCover,
  type PrinterCardTone,
} from "@/components/printers/printerCardModel";
import { usePrinterQuickAction } from "@/components/dashboard/usePrinterQuickAction";
import { FilamentDots } from "@/components/dashboard/FilamentDots";
import { useT } from "@/lib/i18n";
import type { Printer } from "@/lib/types";

const TONE_COLOR: Record<PrinterCardTone, string> = {
  printing: "var(--state-print)",
  paused: "var(--state-warn)",
  collect: "var(--state-warn)",
  warn: "var(--state-warn)",
  error: "var(--state-error)",
  ok: "var(--state-ok)",
  idle: "var(--state-idle)",
  offline: "var(--state-offline)",
};

/** Dense dashboard list row — name, file + progress, temps, ETA, quick actions. */
export function ListRow({
  printer: p,
  onOpen,
  onUpdated,
}: {
  printer: Printer;
  onOpen: (p: Printer) => void;
  onUpdated?: (p: Printer) => void;
}) {
  const t = useT();
  const { act, busy } = usePrinterQuickAction(onUpdated);
  const [armStop, setArmStop] = useState(false);
  const armTimer = useRef<number | null>(null);

  const tone = getPrinterCardTone(p);
  const color = TONE_COLOR[tone];
  const pct = p.progress_pct;
  const cover = printerCover(p);
  const printing = p.state === "printing";
  const paused = p.state === "paused";
  const errored = p.state === "error";
  const hasActions = printing || paused || errored;

  function onStop(e: React.MouseEvent) {
    e.stopPropagation();
    if (!armStop) {
      setArmStop(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmStop(false), 2500);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmStop(false);
    void act(p, "cancel");
  }

  const actionBtn = "grid size-7 place-items-center rounded-md border transition disabled:opacity-40";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(p)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(p)}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 transition hover:border-[var(--border-strong)] active:scale-[.99]"
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${printing ? "animate-pulse" : ""}`}
        style={{ background: color }}
      />

      {cover && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover} alt="" className="h-8 w-8 shrink-0 object-contain" />
      )}

      <div className="w-36 min-w-0 shrink-0 sm:w-44">
        <div className="truncate text-[13px] font-semibold text-[var(--text-hi)]">{p.name}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <FilamentDots printer={p} max={3} />
          {p.nozzle_diameter != null && (
            <span className="shrink-0 rounded border border-[var(--border)] px-1 py-px font-mono text-[9px] leading-none text-[var(--text-muted)]">
              {p.nozzle_diameter}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-[var(--surface-hi)]">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct ?? 0}%`, background: color }}
          />
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
          {pct != null && (printing || paused) ? `${pct}%` : ""}
        </span>
      </div>

      <div className="hidden w-24 shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--text-faint)] md:block">
        {p.extruder_temp != null || p.bed_temp != null
          ? `${p.extruder_temp != null ? `${Math.round(p.extruder_temp)}°` : "—"} / ${p.bed_temp != null ? `${Math.round(p.bed_temp)}°` : "—"}`
          : ""}
      </div>

      <div className="hidden w-24 shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--text-faint)] lg:block">
        {printing && p.eta_minutes != null ? (
          <>
            <span className="block text-[11px] text-[var(--text)]">{formatEtaShort(p.eta_minutes)}</span>
            {formatFinishTime(p.eta_minutes)}
          </>
        ) : (
          ""
        )}
      </div>

      {hasActions && (
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {printing && (
            <button
              type="button"
              disabled={busy}
              title={t("common.pause")}
              aria-label={t("common.pause")}
              onClick={(e) => { e.stopPropagation(); void act(p, "pause"); }}
              className={`${actionBtn} border-[color-mix(in_srgb,var(--state-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_9%,transparent)] text-[var(--state-warn)] hover:brightness-110`}
            >
              <Pause size={12} strokeWidth={2} />
            </button>
          )}
          {paused && (
            <button
              type="button"
              disabled={busy}
              title={t("common.resume")}
              aria-label={t("common.resume")}
              onClick={(e) => { e.stopPropagation(); void act(p, "resume"); }}
              className={`${actionBtn} border-[var(--accent)] bg-[var(--accent)] text-white hover:brightness-110`}
            >
              <Play size={12} strokeWidth={2} />
            </button>
          )}
          {errored && (
            <button
              type="button"
              disabled={busy}
              title={t("common.reset")}
              aria-label={t("common.reset")}
              onClick={(e) => { e.stopPropagation(); void act(p, "clear-error"); }}
              className={`${actionBtn} border-[color-mix(in_srgb,var(--state-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_9%,transparent)] text-[var(--state-warn)] hover:brightness-110`}
            >
              <WrenchSvg />
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            title={armStop ? t("common.confirm") : t("common.stop")}
            aria-label={armStop ? t("common.confirm") : t("common.stop")}
            onClick={onStop}
            className={[
              actionBtn,
              armStop
                ? "border-[var(--state-error)] bg-[var(--state-error)] text-white"
                : "border-[color-mix(in_srgb,var(--state-error)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-error)_8%,transparent)] text-[var(--state-error)] hover:brightness-110",
            ].join(" ")}
          >
            {armStop ? <span className="text-[9px] font-bold">OK?</span> : <Square size={9} strokeWidth={2} className="fill-current" />}
          </button>
        </div>
      )}
    </div>
  );
}

function WrenchSvg() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}
