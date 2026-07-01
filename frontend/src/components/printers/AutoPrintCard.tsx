"use client";

import { useEffect, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { Printer } from "@/lib/types";

function isA1Mini(model: string | null, devId: string | null): boolean {
  const normalized = (model ?? "").toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "");
  return normalized === "n1"
    || (normalized.includes("a1") && normalized.includes("mini"))
    || (devId ?? "").toUpperCase().startsWith("030");
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
  const [enabled, setEnabled] = useState(printer.autoprint_mode === "platecycler");
  const [plates, setPlates] = useState(Math.max(1, printer.autoprint_plates_remaining || 1));
  const [cooldown, setCooldown] = useState(printer.autoprint_cooldown_temp_c || 40);
  const [delay, setDelay] = useState(printer.autoprint_delay_seconds || 0);
  const [ejectLast, setEjectLast] = useState(printer.autoprint_eject_last_plate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(printer.autoprint_mode === "platecycler");
    setPlates(Math.max(1, printer.autoprint_plates_remaining || 1));
    setCooldown(printer.autoprint_cooldown_temp_c || 40);
    setDelay(printer.autoprint_delay_seconds || 0);
    setEjectLast(printer.autoprint_eject_last_plate);
  }, [printer]);

  if (printer.kind !== "bambu" || !isA1Mini(printer.bambu_model, printer.bambu_dev_id)) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api<Printer>(`/api/printers/${printer.id}/autoprint`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          plates_loaded: plates,
          cooldown_temp_c: cooldown,
          delay_seconds: delay,
          eject_last_plate: ejectLast,
        }),
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не вдалося зберегти AutoPrint");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={compact ? "space-y-3 rounded-lg border border-[var(--border)] p-3" : "card space-y-4 p-4"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-hi)]">AutoPrint · PlateCycler</h3>
          <p className="mt-0.5 text-xs text-[var(--text-faint)]">
            Автоматично охолоджує, змінює стіл і запускає наступний друк із плану.
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Увімкнено
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Столів завантажено</span>
          <input
            type="number"
            min={1}
            max={10}
            value={plates}
            onChange={(event) => setPlates(Number(event.target.value))}
            className="input h-8"
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Cooling, °C</span>
          <input
            type="number"
            min={20}
            max={80}
            value={cooldown}
            onChange={(event) => setCooldown(Number(event.target.value))}
            className="input h-8"
          />
        </label>
        <label className="col-span-2 space-y-1 sm:col-span-1">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Затримка, сек</span>
          <input
            type="number"
            min={0}
            max={3600}
            value={delay}
            onChange={(event) => setDelay(Number(event.target.value))}
            className="input h-8"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={ejectLast}
            onChange={(event) => setEjectLast(event.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Виштовхувати останній стіл
        </label>
        <button type="button" onClick={save} disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
          {saving ? "Зберігаю…" : "Застосувати"}
        </button>
      </div>

      <p className="text-[11px] text-[var(--text-faint)]">
        Cooling за замовчуванням — 40°C: принтер виконає <code>M190 S40</code> і чекатиме, доки стіл охолоне, перед зміною пластини.
      </p>
      {printer.autoprint_mode === "platecycler" && (
        <p className="text-xs text-[var(--state-ok)]">
          Активно · доступно столів: {printer.autoprint_plates_remaining}
        </p>
      )}
      {(error || printer.autoprint_error) && (
        <p className="rounded border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] px-3 py-2 text-xs text-[var(--state-error)]">
          {error || printer.autoprint_error}
        </p>
      )}
    </section>
  );
}
