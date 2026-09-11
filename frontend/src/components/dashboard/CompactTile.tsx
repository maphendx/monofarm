"use client";

import { useRef, useState } from "react";
import { Pause, Play, Square, Wrench } from "lucide-react";

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

/** Dense dashboard tile — state rail, name, ETA, progress, quick actions. */
export function CompactTile({
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

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(p)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(p)}
      title={`${p.name}`}
      className="group relative cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 pl-3.5 transition hover:border-[var(--border-strong)] active:scale-[.98]"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />

      <div className="flex min-w-0 items-center gap-2">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="h-9 w-9 shrink-0 object-contain" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${printing ? "animate-pulse" : ""}`}
              style={{ background: color }}
            />
            <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--text-hi)]">{p.name}</span>
            {printing && p.eta_minutes != null && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-faint)]">
                {formatEtaShort(p.eta_minutes)}
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <FilamentDots printer={p} />
            {p.nozzle_diameter != null && (
              <span className="shrink-0 rounded border border-[var(--border)] px-1 py-px font-mono text-[9px] leading-none text-[var(--text-muted)]">
                {p.nozzle_diameter}
              </span>
            )}
          </div>
        </div>
      </div>

      {printing && pct != null ? (
        <>
          <div className="relative mt-1.5 h-4 overflow-hidden rounded-full bg-[var(--surface-hi)]">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
            />
            <span className="absolute inset-0 grid place-items-center font-mono text-[10px] font-semibold leading-none text-[var(--text-hi)]">
              {pct}%
            </span>
          </div>
          {p.eta_minutes != null && (
            <div className="mt-1 text-right font-mono text-[9px] tabular-nums text-[var(--text-faint)]">
              {formatFinishTime(p.eta_minutes)}
            </div>
          )}
        </>
      ) : (
        <div className="mt-1.5 truncate font-mono text-[10px] text-[var(--text-faint)]">
          {p.job ?? "—"}
        </div>
      )}

      {hasActions && (
        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {printing && (
            <button
              type="button"
              disabled={busy}
              title={t("common.pause")}
              aria-label={t("common.pause")}
              onClick={(e) => { e.stopPropagation(); void act(p, "pause"); }}
              className="flex h-7 flex-1 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--state-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_9%,transparent)] text-[var(--state-warn)] transition hover:brightness-110 disabled:opacity-40"
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
              className="flex h-7 flex-1 items-center justify-center rounded-md border border-[var(--accent)] bg-[var(--accent)] text-white transition hover:brightness-110 disabled:opacity-40"
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
              className="flex h-7 flex-1 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--state-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_9%,transparent)] text-[var(--state-warn)] transition hover:brightness-110 disabled:opacity-40"
            >
              <Wrench size={12} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            title={t("common.stop")}
            aria-label={armStop ? t("common.confirm") : t("common.stop")}
            onClick={onStop}
            className={[
              "flex h-7 flex-1 items-center justify-center rounded-md border transition disabled:opacity-40",
              armStop
                ? "border-[var(--state-error)] bg-[var(--state-error)] text-white"
                : "border-[color-mix(in_srgb,var(--state-error)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-error)_8%,transparent)] text-[var(--state-error)] hover:brightness-110",
            ].join(" ")}
          >
            {armStop ? <span className="text-[10px] font-semibold">OK?</span> : <Square size={10} strokeWidth={2} className="fill-current" />}
          </button>
        </div>
      )}
    </div>
  );
}
