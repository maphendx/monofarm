"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { isA1Mini } from "@/lib/printerCapabilities";
import type { AutoPrintStatus, Printer } from "@/lib/types";
import { buildAutoPrintSummary } from "./autoPrintModel";

function PlateStackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
    </svg>
  );
}

function statusTone(status: string | null): string {
  if (status === "printing") return "var(--state-print)";
  if (status === "failed" || status === "lost") return "var(--state-error)";
  if (status === "paused") return "var(--state-warn)";
  return "var(--accent)";
}

export function AutoPrintCard({
  printer,
  onUpdated,
  compact = false,
}: {
  printer: Printer;
  onUpdated: (printer: Printer) => void;
  compact?: boolean;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(printer.autoprint_mode === "platecycler");
  const [plates, setPlates] = useState(Math.max(1, printer.autoprint_plates_remaining || 1));
  const [cooldown, setCooldown] = useState(printer.autoprint_cooldown_temp_c || 40);
  const [delay, setDelay] = useState(printer.autoprint_delay_seconds || 0);
  const [ejectLast, setEjectLast] = useState(printer.autoprint_eject_last_plate);
  const [status, setStatus] = useState<AutoPrintStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api<AutoPrintStatus>(`/api/printers/${printer.id}/autoprint/status`);
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("printers.autoprint.loadFailed"));
    } finally {
      setLoaded(true);
    }
  }, [printer.id, t]);

  useEffect(() => {
    const initial = setTimeout(() => { void loadStatus(); }, 0);
    const interval = setInterval(() => {
      if (!document.hidden) void loadStatus();
    }, enabled ? 5_000 : 20_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [enabled, loadStatus]);

  if (printer.kind !== "bambu" || !isA1Mini(printer.bambu_model, printer.bambu_dev_id)) return null;

  async function save(nextEnabled = enabled) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await api<Printer>(`/api/printers/${printer.id}/autoprint`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: nextEnabled,
          plates_loaded: plates,
          cooldown_temp_c: cooldown,
          delay_seconds: delay,
          eject_last_plate: ejectLast,
        }),
      });
      setEnabled(updated.autoprint_mode === "platecycler");
      onUpdated(updated);
      await loadStatus();
      if (settingsOpen) setSettingsOpen(false);
    } catch (err) {
      setEnabled(printer.autoprint_mode === "platecycler");
      setError(err instanceof ApiError ? err.message : t("printers.autoprint.saveFailed"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function toggle() {
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    void save(nextEnabled);
  }

  const fallbackStatus: AutoPrintStatus = {
    enabled,
    plates_remaining: printer.autoprint_plates_remaining,
    active_job_status: null,
    active_job_progress_pct: null,
    error: printer.autoprint_error,
    entries: [],
  };
  const liveStatus = status ?? fallbackStatus;
  const summary = buildAutoPrintSummary(liveStatus);
  const current = summary.current;
  const visibleEntries = liveStatus.entries.slice(0, compact ? 3 : 5);
  const hiddenCount = Math.max(0, liveStatus.entries.length - visibleEntries.length);
  const operationalError = error || liveStatus.error || printer.autoprint_error;
  const progress = current?.is_active ? liveStatus.active_job_progress_pct : null;

  return (
    <section className={`relative overflow-hidden rounded-2xl border bg-[var(--bg-elevated)] ${
      enabled ? "border-[var(--border-strong)]" : "border-[var(--border)]"
    }`}>
      <div
        className="absolute inset-x-0 top-0 h-1 transition-colors"
        style={{ background: enabled ? statusTone(liveStatus.active_job_status) : "var(--border)" }}
      />

      <div className={compact ? "space-y-4 p-4 pt-5" : "space-y-5 p-5 pt-6"}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${
              enabled
                ? "border-[var(--accent)] bg-[var(--surface-hi)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-faint)]"
            }`}>
              <PlateStackIcon />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--text-hi)]">{t("printers.autoprint.title")}</h2>
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                  {printer.bambu_lan_mode ? t("printers.autoprint.lanMode") : t("printers.autoprint.cloudNoLan")}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--text-faint)]">{t("printers.autoprint.subtitle")}</p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggle}
            disabled={saving}
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-2.5 text-xs font-medium transition disabled:opacity-50 ${
              enabled
                ? "border-[var(--accent)] bg-[var(--surface-hi)] text-[var(--text)]"
                : "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)]"
            }`}
          >
            <span className={`relative h-5 w-9 rounded-full transition ${enabled ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]"}`}>
              <span className={`absolute top-0.5 size-4 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] shadow-sm transition-transform ${enabled ? "translate-x-[18px]" : "translate-x-0.5"}`} />
            </span>
            {enabled ? t("printers.autoprint.enabled") : t("printers.autoprint.disabled")}
          </button>
        </header>

        {enabled && (
          <div className={`grid gap-4 ${compact ? "" : "lg:grid-cols-[minmax(0,1.55fr)_minmax(290px,.75fr)]"}`}>
            <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              {current ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-faint)]">
                        {current.is_active ? t("printers.autoprint.currentRun") : t("printers.autoprint.next")}
                      </p>
                      <p className="mt-1 truncate text-lg font-semibold text-[var(--text-hi)]" title={current.file_name ?? current.title}>
                        {current.file_name ?? current.title}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-2xl font-semibold tabular-nums text-[var(--text)]">
                        {summary.currentCopy}<span className="text-sm font-normal text-[var(--text-faint)]">/{current.runs_total}</span>
                      </p>
                      <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{t("printers.autoprint.copy")}</p>
                    </div>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{
                        background: statusTone(liveStatus.active_job_status),
                        width: `${progress ?? Math.round(current.runs_completed * 100 / current.runs_total)}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--text-faint)]">
                    <span>{current.is_active ? t("printers.autoprint.printing") : t("printers.autoprint.queued")}</span>
                    <span className="font-mono tabular-nums">
                      {progress != null ? `${progress}%` : `${current.runs_completed} ${t("printers.autoprint.of")} ${current.runs_total} ${t("printers.autoprint.done")}`}
                    </span>
                  </div>
                </>
              ) : (
                <div className="py-2">
                  <p className="text-sm font-medium text-[var(--text)]">{t("printers.autoprint.noQueue")}</p>
                  <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--text-faint)]">{t("printers.autoprint.noQueueHint")}</p>
                  <Link href="/queue" className="mt-3 inline-flex text-xs font-medium text-[var(--accent)] hover:underline">
                    {t("printers.autoprint.manageQueue")} →
                  </Link>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
              {[
                [liveStatus.plates_remaining, t("printers.autoprint.platesReady")],
                [summary.totalRunsRemaining, t("printers.autoprint.copiesRemaining")],
                [summary.fileCount, t("printers.autoprint.filesInQueue")],
              ].map(([value, label]) => (
                <div key={String(label)} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 lg:flex lg:items-center lg:justify-between">
                  <p className="font-mono text-xl font-semibold tabular-nums text-[var(--text)] lg:order-2">{value}</p>
                  <p className="mt-0.5 text-[10px] leading-tight text-[var(--text-faint)] lg:mt-0 lg:max-w-24">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {enabled && visibleEntries.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-faint)]">{t("printers.autoprint.queueTitle")}</p>
              <Link href="/queue" className="text-[11px] font-medium text-[var(--accent)] hover:underline">
                {t("printers.autoprint.manageQueue")} →
              </Link>
            </div>
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {visibleEntries.map((entry, index) => {
                const completedPct = Math.round(entry.runs_completed * 100 / entry.runs_total);
                return (
                  <div key={entry.id} className="contents">
                    {index > 0 && <span className="flex shrink-0 items-center text-[var(--text-faint)]">→</span>}
                    <div className={`relative min-w-[150px] flex-1 overflow-hidden rounded-xl border p-3 ${
                      entry.is_active
                        ? "border-[var(--accent)] bg-[var(--surface-hi)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium text-[var(--text)]" title={entry.file_name ?? entry.title}>
                          {entry.file_name ?? entry.title}
                        </p>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                          {entry.runs_completed}/{entry.runs_total}
                        </span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            background: entry.is_active ? statusTone(liveStatus.active_job_status) : "var(--state-ok)",
                            width: `${entry.is_active && progress != null ? progress : completedPct}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <div className="flex min-w-14 items-center justify-center rounded-xl border border-dashed border-[var(--border-strong)] px-3 font-mono text-xs text-[var(--text-muted)]">
                  +{hiddenCount}
                </div>
              )}
            </div>
          </div>
        )}

        {!enabled && (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--text-muted)]">
            {t("printers.autoprint.enableHint")}
          </div>
        )}

        {enabled && summary.plateShortage > 0 && (
          <div className="flex gap-3 rounded-xl border border-[var(--state-warn)] bg-[var(--surface)] px-4 py-3">
            <span className="mt-0.5 text-[var(--state-warn)]">▲</span>
            <div>
              <p className="text-xs font-medium text-[var(--text)]">{t("printers.autoprint.shortageTitle")}</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">
                {t("printers.autoprint.shortageHint")} {summary.plateShortage}.
              </p>
            </div>
          </div>
        )}

        {operationalError && (
          <p className="rounded-xl border border-[var(--state-error)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--state-error)]">
            {operationalError}
          </p>
        )}

        <div className="border-t border-[var(--border)] pt-3">
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            className="flex w-full items-center justify-between gap-3 text-left text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            aria-expanded={settingsOpen}
          >
            <span>{t("printers.autoprint.settings")}</span>
            <span className={`transition-transform ${settingsOpen ? "rotate-180" : ""}`}>⌄</span>
          </button>

          {settingsOpen && (
            <div className="mt-4 grid gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
              <label className="space-y-1">
                <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t("printers.autoprint.platesReady")}</span>
                <input type="number" min={1} max={10} value={plates} onChange={(event) => setPlates(Number(event.target.value))} className="input h-9 w-full" />
              </label>
              <label className="space-y-1">
                <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t("printers.autoprint.cooling")}, °C</span>
                <input type="number" min={20} max={80} value={cooldown} onChange={(event) => setCooldown(Number(event.target.value))} className="input h-9 w-full" />
              </label>
              <label className="space-y-1">
                <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t("printers.autoprint.delay")}, {t("printers.autoprint.seconds")}</span>
                <input type="number" min={0} max={3600} value={delay} onChange={(event) => setDelay(Number(event.target.value))} className="input h-9 w-full" />
              </label>
              <div className="flex flex-col justify-end gap-2 sm:col-span-2 lg:col-span-1">
                <label className="inline-flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <input type="checkbox" checked={ejectLast} onChange={(event) => setEjectLast(event.target.checked)} className="size-4 accent-[var(--accent)]" />
                  {t("printers.autoprint.ejectLast")}
                </label>
                <button type="button" onClick={() => void save()} disabled={saving || !loaded} className="btn btn-primary btn-sm whitespace-nowrap disabled:opacity-50">
                  {saving ? t("common.saving") : t("printers.autoprint.saveSettings")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
