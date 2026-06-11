"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrinterStream } from "@/hooks/usePrinterStream";

import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { BambuJobStatusBadge } from "@/components/printers/BambuJobStatusBadge";
import { BambuJobDetailModal } from "@/components/printers/BambuJobDetailModal";
import { SlotPicker, SlotStrip, slotLabel } from "@/components/printers/SlotStrip";
import type { BambuCloudJob, Filament, FilamentColor, FilamentSlot, Printer, PrinterGroup, PrinterSlotInfo } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

function etaCompletionLabel(min: number | null): string | null {
  if (!min || min <= 0) return null;
  const d = new Date(Date.now() + min * 60_000);
  const time = d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `сьогодні · ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `завтра · ${time}`;
  return `${d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" })} · ${time}`;
}

/** Unified backend badge — one consistent label per operational backend. */
function transportLabel(p: Printer): string {
  if (p.kind === "bambu") return p.bambu_lan_mode ? "Bambu LAN" : "Bambu Cloud";
  if (p.moonraker_url) return "Moonraker";
  return "Вручну";
}

type HealthTone = "ok" | "warn" | "bad" | "muted";

interface HealthSummary {
  tone: HealthTone;
  label: string;
  detail?: string;
}

/**
 * Normalizes per-printer connectivity into one operator-facing vocabulary —
 * connected / degraded / offline / no telemetry — regardless of backend.
 */
function healthSummary(p: Printer): HealthSummary {
  if (!p.is_active) return { tone: "muted", label: "Вимкнено", detail: "Принтер деактивовано" };

  if (p.source === "manual") {
    return { tone: "muted", label: "Без телеметрії", detail: "Стан оновлюється вручну" };
  }

  if (p.state === "offline" || p.state === "not_connected") {
    return { tone: "bad", label: "Офлайн", detail: "Немає зв'язку з принтером" };
  }

  const ageMin = p.updated_at ? (Date.now() - new Date(p.updated_at).getTime()) / 60_000 : null;
  if (ageMin != null && ageMin > 15) {
    return { tone: "warn", label: "Немає свіжих даних", detail: `Останній звіт ${fmtRelative(p.updated_at)}` };
  }

  if (p.state === "error" || p.error_msg) {
    return { tone: "bad", label: "Помилка", detail: p.error_msg ?? "Принтер повідомив про помилку" };
  }

  if (p.flags?.length) {
    return { tone: "warn", label: "Потребує уваги", detail: p.flags.map(flagLabel).join(" · ") };
  }

  return { tone: "ok", label: "На зв'язку", detail: ageMin != null ? `Звіт ${fmtRelative(p.updated_at)}` : undefined };
}

const TONE_COLOR: Record<string, string> = {
  printing: "var(--state-print)",
  ok: "var(--state-ok)",
  warn: "var(--state-warn)",
  bad: "var(--state-error)",
  idle: "var(--state-idle)",
  muted: "var(--state-offline)",
};

function StatusDot({ color, ping = true }: { color: string; ping?: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {ping && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: color }} />
      )}
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

function Card({ title, children, className = "", accent }: { title?: string; children: React.ReactNode; className?: string; accent?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]   ${className}`}>
      {accent && <div className={`absolute inset-y-0 left-0 w-1 ${accent}`} />}
      <div className={accent ? "pl-5 pr-5 py-5" : "p-5"}>
        {title && <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-faint)] ">{title}</p>}
        {children}
      </div>
    </div>
  );
}

// ── temperatures ──────────────────────────────────────────────────────────────


function TemperaturesCard({ printer }: { printer: Printer }) {
  const isMoonraker = !!printer.moonraker_url;
  const [targets, setTargets] = useState({
    extruder: printer.extruder_target ?? 0,
    bed: printer.bed_target ?? 0,
  });

  async function sendTemp(type: "extruder" | "bed", val: number) {
    const script = type === "extruder" ? `M104 S${val}` : `M140 S${val}`;
    try {
      await api(`/api/printers/${printer.id}/gcode`, {
        method: "POST",
        body: JSON.stringify({ script }),
      });
    } catch { /* ignore */ }
  }

  const rows = [
    { label: "Сопло", icon: "nozzle", type: "extruder" as const, max: 350, current: printer.extruder_temp, target: printer.extruder_target },
    { label: "Стіл",  icon: "bed",    type: "bed"      as const, max: 120, current: printer.bed_temp,      target: printer.bed_target },
  ].filter((r) => r.current != null);

  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
      <div className="border-b border-[var(--border)] px-5 py-3 ">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-faint)] ">Температури</p>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {rows.map((r) => {
          const tgt = targets[r.type];
          const heating = r.current! < tgt - 5 && tgt > 40;
          const pct = Math.min(100, (r.current! / Math.max(tgt, r.current!, 30)) * 100);
          return (
            <div key={r.label} className="px-5 py-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {r.icon === "nozzle" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)]">
                      <path d="M12 22V12M8 22h8M9 12h6M12 2v4M9 6h6"/><path d="M7 6a5 5 0 0 0 10 0"/>
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-faint)]">
                      <rect x="2" y="14" width="20" height="6" rx="1"/><path d="M6 14v-4a6 6 0 0 1 12 0v4"/>
                    </svg>
                  )}
                  <span className="text-[11px] font-medium text-[var(--text-muted)] ">{r.label}</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className={`font-mono text-sm font-bold tabular-nums ${
                    heating ? "text-[var(--state-warn)]" : "text-[var(--text)] "
                  }`}>
                    {Math.round(r.current!)}°
                  </span>
                  <span className="text-[var(--text-muted)] ">→</span>
                  <input
                    type="number"
                    min={0}
                    max={r.max}
                    value={tgt}
                    disabled={!isMoonraker}
                    onChange={(e) => setTargets((prev) => ({ ...prev, [r.type]: Number(e.target.value) }))}
                    onBlur={(e) => { if (isMoonraker) sendTemp(r.type, Number(e.target.value)); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (isMoonraker) sendTemp(r.type, tgt);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    className={[
                      "w-14 rounded bg-[var(--surface-hi)] px-2 py-0.5 text-right font-mono text-sm tabular-nums outline-none ",
                      isMoonraker
                        ? "text-[var(--accent)]  border border-transparent focus:border-[rgba(34,211,238,.5)] focus:ring-1 focus:ring-[rgba(34,211,238,.3)] cursor-text"
                        : "text-[var(--text-faint)] cursor-default",
                    ].join(" ")}
                  />
                  <span className="text-sm text-[var(--text-faint)]">°</span>
                </div>
              </div>
              <div className="flex gap-px">
                {Array.from({ length: 20 }).map((_, i) => {
                  const filled = (i / 20) * 100 < pct;
                  return (
                    <div key={i} className={`h-1 flex-1 rounded-sm transition-colors duration-300 ${
                      filled ? pct > 90 ? "bg-[var(--state-error)]" : pct > 70 ? "bg-[var(--state-warn)]" : "bg-[var(--accent)]"
                             : "bg-[var(--surface-hi)]"
                    }`} />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {isMoonraker && (
        <p className="px-5 pb-3 text-[10px] text-[var(--text-faint)] ">
          Enter або blur — надсилає M104/M140
        </p>
      )}
    </div>
  );
}

// ── print status + controls ───────────────────────────────────────────────────

// ── control panel (Moonraker only) ───────────────────────────────────────────

const MOVE_DISTANCES = [0.1, 1, 10, 50, 100];

const BAMBU_SPEEDS = [
  { label: "Тихий", profile: 1, pct: 25 },
  { label: "Стандарт", profile: 2, pct: 50 },
  { label: "Спорт", profile: 3, pct: 75 },
  { label: "Ludicrous", profile: 4, pct: 100 },
];

function JogCard({ printer }: { printer: Printer }) {
  const user = useUser();
  const [dist, setDist] = useState(10);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isBambu = printer.kind === "bambu" && !!printer.bambu_dev_id;
  const isMoonraker = !!printer.moonraker_url;

  if (!isBambu && !isMoonraker) return null;
  if (user.role !== "admin" && user.role !== "operator") return null;

  async function gcode(script: string, key: string) {
    if (busy) return;
    setBusy(key);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/gcode`, {
        method: "POST",
        body: JSON.stringify({ script }),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  // Mechanical arrow button — tactile feel
  const axisBtn = (dir: string, script: string, key: string, svgPath: string) => (
    <button
      type="button"
      onClick={() => gcode(script, key)}
      disabled={busy !== null}
      title={`${dir} ${dist}мм`}
      className="flex size-10 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text-muted)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] transition active:shadow-none active:translate-y-px hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)] disabled:opacity-40    "
    >
      {busy === key ? (
        <span className="text-[10px]">…</span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d={svgPath} />
        </svg>
      )}
    </button>
  );

  const homeBtn = (label: string, script: string, key: string) => (
    <button
      type="button"
      onClick={() => gcode(script, key)}
      disabled={busy !== null}
      className="flex size-10 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-muted)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] disabled:opacity-40    "
      title={`Home ${label}`}
    >
      {busy === key ? (
        <span className="text-[10px]">…</span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>
        </svg>
      )}
    </button>
  );

  const utilBtn = (label: string, script: string, key: string, icon: string, colorCls = "text-[var(--text-muted)] ") => (
    <button
      type="button"
      onClick={() => gcode(script, key)}
      disabled={busy !== null}
      className={`flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[var(--surface-hi)] disabled:opacity-40    ${colorCls}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={icon} />
      </svg>
      {busy === key ? "…" : label}
    </button>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3 ">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-faint)] ">Керування · переміщення</p>
        <span className="font-mono text-[10px] uppercase text-[var(--text-faint)] ">{isBambu ? `${transportLabel(printer)} · G-code` : "Moonraker · G-code"}</span>
      </div>

      <div className="p-5 space-y-5">
        <div>
          {/* Step size */}
          <div className="mb-4 flex items-center gap-px overflow-hidden rounded-md border border-[var(--border)]  w-fit">
            {MOVE_DISTANCES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDist(d)}
                className={`px-3 py-1.5 text-[11px] font-medium tabular-nums transition ${
                  dist === d
                    ? "bg-[var(--accent)] text-white  "
                    : "bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   "
                }`}
              >
                {d < 1 ? d : d}
                <span className="ml-0.5 text-[9px] opacity-60">мм</span>
              </button>
            ))}
          </div>

          {/* Pad */}
          <div className="flex items-start gap-4">
            {/* XY */}
            <div>
              <p className="mb-2 text-[9px] uppercase tracking-widest text-[var(--text-muted)] ">X / Y</p>
              <div className="grid grid-cols-3 gap-1">
                <div />
                {axisBtn("Y+", `G91\nG0 Y${dist} F3000\nG90`, "y+", "M12 19V5M5 12l7-7 7 7")}
                <div />
                {axisBtn("X-", `G91\nG0 X-${dist} F3000\nG90`, "x-", "M19 12H5M12 19l-7-7 7-7")}
                {homeBtn("XY", "G28 X Y", "home-xy")}
                {axisBtn("X+", `G91\nG0 X${dist} F3000\nG90`, "x+", "M5 12h14M12 5l7 7-7 7")}
                <div />
                {axisBtn("Y-", `G91\nG0 Y-${dist} F3000\nG90`, "y-", "M12 5v14M19 12l-7 7-7-7")}
                <div />
              </div>
            </div>

            {/* Z */}
            <div>
              <p className="mb-2 text-[9px] uppercase tracking-widest text-[var(--text-muted)] ">Z</p>
              <div className="flex flex-col gap-1">
                {axisBtn("Z+", `G91\nG0 Z${dist} F300\nG90`, "z+", "M12 19V5M5 12l7-7 7 7")}
                {homeBtn("Z", "G28 Z", "home-z")}
                {axisBtn("Z-", `G91\nG0 Z-${dist} F300\nG90`, "z-", "M12 5v14M19 12l-7 7-7-7")}
              </div>
            </div>

            {/* Home all */}
            <div className="mt-7">
              <button
                type="button"
                onClick={() => gcode("G28", "home-all")}
                disabled={busy !== null}
                className="flex flex-col items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[10px] font-medium text-[var(--text-muted)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[var(--surface-hi)] disabled:opacity-40   "
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>
                </svg>
                {busy === "home-all" ? "…" : "Всі"}
              </button>
            </div>
          </div>
        </div>

        <div className="h-px bg-[var(--surface-hi)] " />

        {/* ── Utilities ── */}
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)]">Допоміжні</p>
          <div className="flex flex-wrap gap-2">
            {utilBtn("Мотори вимк", "M84", "motors-off", "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18")}
            {utilBtn("Вент увімк", "M106 S255", "fan-on", "M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2 2 0 1 1 19.5 12H2")}
            {utilBtn("Вент вимк", "M107", "fan-off", "M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2 2 0 1 1 19.5 12H2")}
            {utilBtn("Охолодити", "M104 S0\nM140 S0", "cool-down", "M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "text-[var(--accent)]")}
          </div>
        </div>

        {err && <p className="text-xs text-[var(--state-error)]">{err}</p>}
      </div>
    </div>
  );
}

const SPEED_COLORS = [
  "border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text-muted)] hover:bg-[var(--surface-hi)]",
  "border-[var(--state-print)] bg-[rgba(56,189,248,.10)] text-[var(--state-print)] hover:bg-[rgba(56,189,248,.15)]",
  "border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] text-[var(--state-warn)] hover:bg-[rgba(245,158,11,.15)]",
  "border-[var(--state-error)] bg-[rgba(239,68,68,.10)] text-[var(--state-error)] hover:bg-[rgba(239,68,68,.15)]",
];

function SpeedCard({ printer }: { printer: Printer }) {
  const user = useUser();
  const [speed, setSpeed] = useState(100);
  const [flow, setFlow] = useState(100);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isBambu = printer.kind === "bambu" && !!printer.bambu_dev_id;
  const isMoonraker = !!printer.moonraker_url;

  if (!isBambu && !isMoonraker) return null;
  if (user.role !== "admin" && user.role !== "operator") return null;

  async function gcode(script: string, key: string) {
    if (busy) return;
    setBusy(key);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/gcode`, {
        method: "POST",
        body: JSON.stringify({ script }),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  async function setSpeedProfile(profile: number) {
    if (busy) return;
    setBusy(`sp${profile}`);
    setErr(null);
    try {
      await api(`/api/printers/${printer.id}/speed-profile`, {
        method: "POST",
        body: JSON.stringify({ profile }),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3 ">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-faint)] ">Швидкість друку</p>
        <span className="font-mono text-[10px] uppercase text-[var(--text-faint)] ">{isBambu ? "SPD_LVL · Bambu" : "M220 · Moonraker"}</span>
      </div>

      <div className="p-5 space-y-5">
        {isBambu ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {BAMBU_SPEEDS.map((s, i) => (
              <button
                key={s.profile}
                type="button"
                onClick={() => setSpeedProfile(s.profile)}
                disabled={busy !== null}
                className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-center text-[11px] font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition disabled:opacity-40 ${SPEED_COLORS[i]}`}
              >
                <span className="text-[9px] font-bold tracking-widest opacity-60">
                  {"▮".repeat(i + 1)}
                </span>
                {busy === `sp${s.profile}` ? "…" : s.label}
                <span className="text-[9px] opacity-50 tabular-nums">{s.pct}%</span>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)]">Швидкість</p>
            <div className="flex items-center gap-2">
              <input
                type="number" min={10} max={300} value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-20 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-center font-mono text-sm  "
              />
              <span className="text-xs text-[var(--text-faint)]">%</span>
              <button
                type="button"
                onClick={() => gcode(`M220 S${speed}`, "speed")}
                disabled={busy !== null}
                className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] hover:bg-[var(--surface-hi)] disabled:opacity-40   "
              >
                {busy === "speed" ? "…" : "Задати"}
              </button>
            </div>
          </div>
        )}

        {isMoonraker && (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)]">Витрата пластику</p>
            <div className="flex items-center gap-2">
              <input
                type="number" min={50} max={200} value={flow}
                onChange={(e) => setFlow(Number(e.target.value))}
                className="w-20 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-center font-mono text-sm  "
              />
              <span className="text-xs text-[var(--text-faint)]">%</span>
              <button
                type="button"
                onClick={() => gcode(`M221 S${flow}`, "flow")}
                disabled={busy !== null}
                className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] hover:bg-[var(--surface-hi)] disabled:opacity-40   "
              >
                {busy === "flow" ? "…" : "Задати"}
              </button>
            </div>
          </div>
        )}

        {err && <p className="text-xs text-[var(--state-error)]">{err}</p>}
      </div>
    </div>
  );
}

function JobHeroCard({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: () => void;
}) {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmClearBed, setConfirmClearBed] = useState(false);
  const [camLoaded, setCamLoaded] = useState(false);
  const [camError, setCamError] = useState(false);
  const [tick, setTick] = useState(0);

  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isOperational = printer.state === "operational" || printer.state === "awaiting_bed_clear";
  const isError = printer.state === "error";
  const hasMoonraker = !!printer.moonraker_url;
  const isBambuCam = printer.kind === "bambu" && !!printer.bambu_dev_ip;
  const hasCamera = hasMoonraker || isBambuCam;
  const eta = formatEta(printer.eta_minutes);
  const completion = etaCompletionLabel(printer.eta_minutes);
  const dotColor = TONE_COLOR[printerTone(printer)] ?? "var(--state-idle)";
  const token = getToken();

  useEffect(() => {
    if (isBambuCam || !hasCamera) return;
    const id = setInterval(() => { if (!document.hidden) setTick((n) => n + 1); }, 2500);
    return () => clearInterval(id);
  }, [isBambuCam, hasCamera]);

  useEffect(() => {
    if (!isBambuCam) setCamLoaded(false);
  }, [tick, isBambuCam]);

  const camSrc = isBambuCam
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${token}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?t=${tick}&token=${token}`;

  const meta = printer.current_filament_meta;
  const totalGrams = meta?.used_g?.reduce((a, b) => a + b, 0);

  async function act(action: string) {
    if (busy) return;
    setBusy(action);
    setErr(null);
    setConfirmCancel(false);
    setConfirmClearBed(false);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      onUpdated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)]  ">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3 ">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-faint)] ">Поточне завдання</p>
        <span className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
          {transportLabel(printer)}
        </span>
      </div>

      {/* ── camera panel — one consistent UI/placeholder regardless of source ── */}
      <div className="relative aspect-video w-full overflow-hidden border-b border-[var(--border)] bg-[var(--bg)]">
        {!hasCamera ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--text-muted)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.82V15.18a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            </svg>
            <span className="text-xs">
              {isBambuCam || printer.kind !== "bambu"
                ? "Камера не налаштована для цього принтера"
                : "Камера доступна через локальний агент — додайте LAN IP в налаштуваннях"}
            </span>
          </div>
        ) : camError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.82V15.18a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            </svg>
            <span className="text-xs">Камера недоступна</span>
            <button onClick={() => { setCamError(false); setCamLoaded(false); }}
              className="text-[11px] text-[var(--text-muted)] underline hover:text-[var(--text)]">
              Повторити
            </button>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={camSrc}
            alt="Camera"
            className={`h-full w-full object-cover transition-opacity duration-300 ${camLoaded ? "opacity-100" : "opacity-0"}`}
            onLoad={() => setCamLoaded(true)}
            onError={() => setCamError(true)}
          />
        )}
        {hasCamera && camLoaded && !camError && (
            <>
              <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)] backdrop-blur-sm">
                <span className="size-1.5 rounded-full animate-pulse" style={{ background: "var(--state-error)" }} />
                LIVE
              </span>
              {(printer.extruder_temp != null || printer.bed_temp != null) && (
                <div className="absolute bottom-3 left-3 flex gap-4 rounded-md bg-black/55 px-3 py-1.5 backdrop-blur-sm">
                  {printer.extruder_temp != null && (
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-[var(--text-faint)]">Сопло</div>
                      <div className="font-mono text-sm font-semibold text-[var(--text-hi)]">{Math.round(printer.extruder_temp)}°</div>
                    </div>
                  )}
                  {printer.bed_temp != null && (
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-[var(--text-faint)]">Стіл</div>
                      <div className="font-mono text-sm font-semibold text-[var(--text-hi)]">{Math.round(printer.bed_temp)}°</div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
      </div>

      {printer.error_msg && (
        <div className="flex items-start gap-2 border-b border-[var(--border)] bg-[rgba(239,68,68,.06)] px-5 py-3">
          <svg className="mt-0.5 shrink-0 text-[var(--state-error)]" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p className="text-xs text-[var(--state-error)]">{printer.error_msg}</p>
        </div>
      )}

      {(printer.job || isPrinting || isPaused) && (
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-[var(--border)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <StatusDot color={dotColor} ping={isPrinting} />
            <span className="text-xs font-medium" style={{ color: dotColor }}>{stateLabel(printer.state)}</span>
          </div>
          <div className="min-w-0">
            {printer.job && <p className="truncate font-mono text-[13px] font-medium text-[var(--text)] ">{printer.job}</p>}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--text-faint)]">
              {meta?.types?.[0] && <span>{meta.types[0]}</span>}
              {totalGrams != null && totalGrams > 0 && <span>{Math.round(totalGrams)} г</span>}
              {meta?.layer_height != null && <span>{meta.layer_height} мм</span>}
              <span>джерело <b className="text-[var(--text)]">{printer.source}</b></span>
            </div>
          </div>
          {eta && (
            <div className="text-right">
              <div className="font-mono text-lg font-semibold tabular-nums text-[var(--text-hi)]">{eta}</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-dim)]">
                {completion ? `завершення · ${completion}` : "залишилось"}
              </div>
            </div>
          )}
        </div>
      )}

      {printer.progress_pct != null && (
        <div className="border-b border-[var(--border)] px-5 py-3.5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13px] font-semibold text-[var(--text-hi)]">прогрес · <b style={{ color: "var(--state-print)" }}>{printer.progress_pct}%</b></span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--surface-hi)]">
            <div className="h-full rounded-full transition-[width] duration-1000 ease-linear" style={{ background: "var(--state-print)", width: `${printer.progress_pct}%` }} />
          </div>
        </div>
      )}

      {canEdit && (isPrinting || isPaused || isOperational || isError) && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-3.5">
          {isPrinting && (
            <button onClick={() => act("pause")} disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-md border border-[var(--state-warn)] bg-[rgba(245,158,11,.10)] px-4 py-2 text-xs font-medium text-[var(--state-warn)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[rgba(245,158,11,.15)] disabled:opacity-40">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              {busy === "pause" ? "…" : "Пауза"}
            </button>
          )}
          {isPaused && (
            <button onClick={() => act("resume")} disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-md border border-[var(--state-ok)] bg-[rgba(34,197,94,.10)] px-4 py-2 text-xs font-medium text-[var(--state-ok)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              {busy === "resume" ? "…" : "Продовжити"}
            </button>
          )}
          {(isPrinting || isPaused) && (
            confirmCancel ? (
              <div className="flex items-center gap-2 rounded-md border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] px-3 py-2">
                <span className="text-xs text-[var(--state-error)]">Зупинити друк?</span>
                <button onClick={() => act("cancel")} disabled={busy !== null}
                  className="text-xs font-bold text-[var(--state-error)] hover:underline disabled:opacity-40">
                  {busy === "cancel" ? "…" : "Так"}
                </button>
                <span className="text-[var(--text-muted)]">·</span>
                <button onClick={() => setConfirmCancel(false)} className="text-xs text-[var(--text-muted)] hover:underline">Ні</button>
              </div>
            ) : (
              <button onClick={() => setConfirmCancel(true)} disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-[var(--state-error)] bg-[rgba(239,68,68,.10)] px-4 py-2 text-xs font-medium text-[var(--state-error)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[rgba(239,68,68,.15)] disabled:opacity-40">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
                Зупинити
              </button>
            )
          )}
          {isOperational && (
            confirmClearBed ? (
              <div className="flex items-center gap-2 rounded-md border border-[rgba(34,197,94,.2)] bg-[rgba(34,197,94,.08)] px-3 py-2">
                <span className="text-xs text-[var(--state-ok)]">Стіл справді очищено?</span>
                <button onClick={() => act("clear-bed")} disabled={busy !== null}
                  className="text-xs font-bold text-[var(--state-ok)] hover:underline disabled:opacity-40">
                  {busy === "clear-bed" ? "…" : "Так"}
                </button>
                <span className="text-[var(--text-muted)]">·</span>
                <button onClick={() => setConfirmClearBed(false)} className="text-xs text-[var(--text-muted)] hover:underline">Ні</button>
              </div>
            ) : (
              <button onClick={() => setConfirmClearBed(true)} disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-[var(--state-ok)] bg-[rgba(34,197,94,.10)] px-4 py-2 text-xs font-medium text-[var(--state-ok)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[rgba(34,197,94,.15)] disabled:opacity-40">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Стіл очищено
              </button>
            )
          )}
          {isError && (
            <button onClick={() => act("clear-error")} disabled={busy !== null}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-xs font-medium text-[var(--text-muted)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[var(--surface-hi)] disabled:opacity-40   ">
              {busy === "clear-error" ? "…" : "Скинути помилку"}
            </button>
          )}
          {isPrinting && hasMoonraker && (
            <button onClick={() => act("skip-object")} disabled={busy !== null}
              title="Потребує [exclude_object] в printer.cfg"
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-4 py-2 text-xs font-medium text-[var(--text-muted)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-[var(--surface-hi)] disabled:opacity-40   ">
              {busy === "skip-object" ? "…" : "Пропустити об'єкт"}
            </button>
          )}
        </div>
      )}

      {err && <p className="px-5 pb-3.5 text-xs text-[var(--state-error)]">{err}</p>}
    </div>
  );
}

// ── spool icon helpers ────────────────────────────────────────────────────────

function normalizeHex(value: string): string {
  const raw = value.trim().replace(/^#/, "");
  if (!raw) return "";
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return value.trim();
  return `#${raw.toUpperCase()}`;
}

function colorHex(c: string | null | undefined): string {
  const hex = normalizeHex(c ?? "");
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#888888";
}

/** SVG spool icon mimicking a real filament reel */
function SpoolIcon({ color, size = 72 }: { color: string; size?: number }) {
  const hex = colorHex(color);
  const cx = size / 2;
  const r = size / 2 - 2;
  const rimR = r * 0.65;
  const hubR = r * 0.28;
  const spokeCount = 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill={hex} stroke="rgba(0,0,0,0.18)" strokeWidth="1.5" />
      <circle cx={cx} cy={cx} r={rimR} fill="rgba(0,0,0,0.30)" />
      {Array.from({ length: spokeCount }).map((_, k) => {
        const angle = (k * 2 * Math.PI) / spokeCount - Math.PI / 2;
        const x1 = cx + hubR * 1.05 * Math.cos(angle);
        const y1 = cx + hubR * 1.05 * Math.sin(angle);
        const x2 = cx + rimR * 0.96 * Math.cos(angle);
        const y2 = cx + rimR * 0.96 * Math.sin(angle);
        return <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.22)" strokeWidth="1.7" strokeLinecap="round" />;
      })}
      <circle cx={cx} cy={cx} r={hubR} fill={hex} stroke="rgba(0,0,0,0.25)" strokeWidth="1.5" />
      <circle cx={cx} cy={cx} r={r * 0.09} fill="rgba(0,0,0,0.45)" />
    </svg>
  );
}

/** Empty slot placeholder spool */
function EmptySpoolIcon({ size = 72 }: { size?: number }) {
  const cx = size / 2;
  const r = size / 2 - 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="transparent" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" className="text-[var(--text-muted)] " />
      <circle cx={cx} cy={cx} r={r * 0.28} fill="transparent" stroke="currentColor" strokeWidth="1.5" className="text-[var(--text-muted)] " />
    </svg>
  );
}

// ── filament card ─────────────────────────────────────────────────────────────

function FilamentCard({ printer }: { printer: Printer }) {
  const meta = printer.current_filament_meta;
  if (!meta) return null;
  const slots = Math.max(meta.colors?.length ?? 0, meta.types?.length ?? 0);
  if (slots === 0) return null;

  return (
    <Card title="Пластик у поточному друці">
      <div className="flex flex-wrap gap-5">
        {Array.from({ length: slots }).map((_, i) => {
          const color = meta.colors?.[i] ?? "#888";
          const type = meta.types?.[i] ?? "—";
          const grams = meta.used_g?.[i];
          return (
            <div key={i} className="flex flex-col items-center gap-1.5 text-center">
              <SpoolIcon color={color} size={64} />
              <div className="max-w-[76px]">
                <div className="text-xs font-semibold leading-tight">{type}</div>
                {grams != null && (
                  <div className="text-[10px] text-[var(--text-faint)]">{grams} г</div>
                )}
                <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">#{i + 1}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
        {meta.estimated_minutes != null && (
          <span>{formatEta(meta.estimated_minutes)}</span>
        )}
        {meta.total_layers != null && (
          <span>{meta.total_layers} шарів</span>
        )}
        {meta.layer_height != null && (
          <span>↕ {meta.layer_height} мм</span>
        )}
      </div>
    </Card>
  );
}

// ── Bambu Cloud jobs card ─────────────────────────────────────────────────────

function fmtJobDt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const JOBS_PAGE_LIMIT = 10;

function BambuJobsCard({ printer }: { printer: Printer }) {
  const [activeJob, setActiveJob] = useState<BambuCloudJob | null>(null);
  const [recent, setRecent] = useState<BambuCloudJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openJobId, setOpenJobId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [active, list] = await Promise.all([
        api<BambuCloudJob | null>(`/api/printers/${printer.id}/active-job`),
        api<{ items: BambuCloudJob[]; total: number }>(
          `/api/bambu-jobs?printer_id=${printer.id}&limit=${JOBS_PAGE_LIMIT}`,
        ),
      ]);
      setActiveJob(active);
      setRecent(list.items);
      setTotal(list.total);
    } catch {
      /* ignore — non-critical panel */
    } finally {
      setLoaded(true);
    }
  }, [printer.id]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const list = await api<{ items: BambuCloudJob[]; total: number }>(
        `/api/bambu-jobs?printer_id=${printer.id}&limit=${JOBS_PAGE_LIMIT}&offset=${recent.length}`,
      );
      setRecent((prev) => [...prev, ...list.items]);
      setTotal(list.total);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void load(); }, activeJob ? 5000 : 25000);
    return () => clearInterval(t);
  }, [load, activeJob]);

  if (!loaded) return null;
  if (!activeJob && recent.length === 0) return null;

  const hasMore = recent.length < total;

  return (
    <Card title="Завдання друку">
      {activeJob && (
        <button onClick={() => setOpenJobId(activeJob.id)}
          className="mb-3 block w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-left transition hover:border-[var(--border-strong)]">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="truncate text-[13px] font-medium text-[var(--text)]" title={activeJob.file_name ?? ""}>
              {activeJob.file_name ?? `Завдання #${activeJob.id}`}
            </p>
            <BambuJobStatusBadge status={activeJob.status} className="shrink-0" />
          </div>
          {activeJob.progress_pct != null && (
            <div className="mb-1.5">
              <div className="relative h-2 overflow-hidden rounded-sm bg-[var(--surface-hi)]">
                <div className="h-full transition-[width] duration-1000 ease-linear"
                  style={{ background: "var(--state-print)", width: `${activeJob.progress_pct}%` }} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--text-faint)]">
            {activeJob.progress_pct != null && <span>{activeJob.progress_pct}%</span>}
            {activeJob.eta_minutes != null && <span>⏱ ~{activeJob.eta_minutes} хв</span>}
            <span>оновлено {fmtJobDt(activeJob.last_mqtt_at ?? activeJob.updated_at)}</span>
          </div>
        </button>
      )}

      {recent.length > 0 && (
        <div>
          <div className="-mt-1 mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-[var(--text-muted)]">
              Останні завдання{total > 0 ? ` · ${total}` : ""}
            </p>
            <Link href={`/printers/jobs?printer_id=${printer.id}`}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">
              Всі →
            </Link>
          </div>
          <ul className="space-y-1">
            {recent.map((j) => (
              <li key={j.id}>
                <button onClick={() => setOpenJobId(j.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-[var(--surface-hi)]">
                  <span className="truncate text-[var(--text-muted)]" title={j.file_name ?? ""}>{j.file_name ?? `#${j.id}`}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[var(--text-faint)]">{fmtJobDt(j.created_at)}</span>
                    <BambuJobStatusBadge status={j.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-2 w-full rounded-md border border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)] disabled:opacity-50"
            >
              {loadingMore ? "…" : `Завантажити ще (${total - recent.length})`}
            </button>
          )}
        </div>
      )}

      {openJobId != null && (
        <BambuJobDetailModal jobId={openJobId} onClose={() => setOpenJobId(null)} onChanged={load} />
      )}
    </Card>
  );
}

// ── loaded filaments card ─────────────────────────────────────────────────────

const PRESET_TYPES = ["PLA", "PETG", "ABS", "ASA", "TPU", "PC", "Nylon", "PLA+", "PETG-CF", "ABS-CF"];

/** Modal colour-palette picker + manager */
function ColorPaletteModal({
  slotLabel,
  onPick,
  onClose,
}: {
  slotLabel: string;
  onPick: (c: FilamentColor) => void;
  onClose: () => void;
}) {
  const [colors, setColors] = useState<FilamentColor[]>([]);
  const [newName, setNewName] = useState("");
  const [newHex, setNewHex] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editHex, setEditHex] = useState("#ffffff");

  function load() {
    api<FilamentColor[]>("/api/filament-colors").then(setColors).catch(() => {});
  }

  useEffect(() => { load(); }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function createColor() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api("/api/filament-colors", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), hex_color: newHex }),
      });
      setNewName(""); setNewHex("#ffffff");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number) {
    await api(`/api/filament-colors/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: editName.trim(), hex_color: editHex }),
    });
    setEditingId(null);
    load();
  }

  async function deleteColor(id: number) {
    await api(`/api/filament-colors/${id}`, { method: "DELETE" });
    load();
  }

  function startEdit(c: FilamentColor) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditHex(c.hex_color);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-[var(--bg-elevated)] shadow-2xl "
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4 ">
          <div>
            <h2 className="text-base font-semibold">Палітра кольорів</h2>
            <p className="text-xs text-[var(--text-muted)]">Вибери колір для слоту {slotLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)] "
          >
            ✕
          </button>
        </div>

        {/* color grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {colors.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-faint)]">Збережених кольорів ще немає</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {colors.map((c) => (
                <div key={c.id} className="group relative">
                  {editingId === c.id ? (
                    /* edit row */
                    <div className="col-span-1 flex flex-col gap-1 rounded-xl border border-[var(--border-strong)] bg-[var(--bg)] p-2  ">
                      <div className="relative mx-auto size-10">
                        <div className="size-10 rounded-full ring-1 ring-black/15" style={{ backgroundColor: editHex }} />
                        <input
                          type="color"
                          value={editHex}
                          onChange={(e) => setEditHex(e.target.value)}
                          className="absolute inset-0 size-full cursor-pointer opacity-0"
                        />
                      </div>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1 py-0.5 text-[10px] outline-none  "
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(c.id)}
                      />
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => saveEdit(c.id)}
                          className="flex-1 rounded bg-[var(--accent)] py-0.5 text-[10px] text-white  "
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="flex-1 rounded border border-[var(--border)] py-0.5 text-[10px] text-[var(--text-muted)] "
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* normal card */
                    <button
                      type="button"
                      onClick={() => { onPick(c); onClose(); }}
                      className="flex w-full flex-col items-center gap-1.5 rounded-xl p-2 text-center hover:bg-[var(--surface-hi)] "
                    >
                      <span
                        className="block size-10 rounded-full ring-1 ring-black/15 dark:ring-white/15"
                        style={{ backgroundColor: c.hex_color }}
                      />
                      <span className="w-full truncate text-[11px] leading-tight text-[var(--text)] ">
                        {c.name}
                      </span>
                    </button>
                  )}

                  {/* action dots */}
                  {editingId !== c.id && (
                    <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); startEdit(c); }}
                        className="flex size-4 items-center justify-center rounded-full bg-[var(--surface-2)] text-[8px] text-[var(--text-muted)]"
                        title="Редагувати"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteColor(c.id); }}
                        className="flex size-4 items-center justify-center rounded-full bg-[var(--state-error)] text-[8px] text-white"
                        title="Видалити"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* add new color */}
        <div className="border-t border-[var(--border)] p-4 ">
          <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Додати новий колір</p>
          <div className="flex items-center gap-2">
            <div className="relative shrink-0">
              <div className="size-9 rounded-full ring-1 ring-black/15" style={{ backgroundColor: newHex }} />
              <input
                type="color"
                value={newHex}
                onChange={(e) => setNewHex(e.target.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </div>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Назва кольору…"
              className="flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--border-focus)]"
              onKeyDown={(e) => e.key === "Enter" && createColor()}
            />
            <button
              type="button"
              onClick={createColor}
              disabled={busy || !newName.trim()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40  "
            >
              {busy ? "…" : "+ Додати"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function AmsDisplay({
  slots,
  activeTray,
  inventory,
}: {
  slots: FilamentSlot[];
  activeTray: number | null;
  inventory: Filament[];
}) {
  // Group by unit_id, external (slot 254) separate
  const units = new Map<number, FilamentSlot[]>();
  const external: FilamentSlot[] = [];

  for (const s of slots) {
    if (s.slot === 254) { external.push(s); continue; }
    const uid = s.unit_id ?? 0;
    if (!units.has(uid)) units.set(uid, []);
    units.get(uid)!.push(s);
  }
  const sortedUnits = [...units.entries()].sort(([a], [b]) => a - b);

  return (
    <div className="space-y-4">
      {sortedUnits.map(([uid, unitSlots]) => (
        <div key={uid}>
          {sortedUnits.length > 1 && (
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-faint)]">
              AMS {uid + 1}
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            {unitSlots.sort((a, b) => a.slot - b.slot).map((s) => {
              const isActive = activeTray === s.slot;
              const invItem = s.filament_id ? inventory.find((f) => f.id === s.filament_id) : null;
              const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
              const label = String.fromCharCode(65 + (s.slot % 4)); // A B C D
              return (
                <div
                  key={s.slot}
                  title={s.empty ? "Порожній" : `${s.type}${s.brand ? ` · ${s.brand}` : ""}${s.color_name ? ` (${s.color_name})` : ""}`}
                  className={[
                    "relative flex flex-col items-center gap-2 rounded-xl border-2 px-2 py-3 transition-all",
                    isActive
                      ? "border-[var(--state-print)] bg-[rgba(56,189,248,.08)] shadow-sm"
                      : "border-[var(--border)] ",
                  ].join(" ")}
                >
                  {isActive && (
                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white leading-none" style={{ background: "var(--state-print)" }}>
                      друкує
                    </span>
                  )}
                  {s.empty ? (
                    <div className="size-7 rounded-full border-2 border-dashed border-[var(--border)] " />
                  ) : (
                    <div
                      className="size-7 rounded-full ring-2 ring-black/10 dark:ring-white/10"
                      style={{ backgroundColor: hex }}
                    />
                  )}
                  <div className="w-full text-center">
                    <div className="truncate text-[11px] font-semibold leading-tight text-[var(--text)] ">
                      {s.empty ? "—" : (s.type || "?")}
                    </div>
                    {invItem && (
                      <div className="text-[9px] text-[var(--text-faint)]">{invItem.grams_remaining} г</div>
                    )}
                    <div className="text-[9px] text-[var(--text-faint)]">{label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {external.map((s) => {
        const isActive = activeTray === s.slot;
        const hex = s.color.startsWith("#") ? s.color.slice(0, 7) : s.color;
        return (
          <div key={s.slot} className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-4 py-3 ">
            <div
              className="size-6 shrink-0 rounded-full ring-2"
            style={{ boxShadow: isActive ? `0 0 0 2px var(--state-print)` : undefined, backgroundColor: hex }}
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold">{s.type || "—"}</div>
              {s.brand && <div className="text-[10px] text-[var(--text-faint)]">{s.brand}</div>}
            </div>
            <span className="ml-auto text-[10px] text-[var(--text-faint)]">Зовнішня</span>
            {isActive && <span className="rounded-full px-2 py-0.5 text-[9px] font-bold text-white" style={{ background: "var(--state-print)" }}>друкує</span>}
          </div>
        );
      })}
    </div>
  );
}

function LoadedFilamentsCard({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: () => void;
}) {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";

  const [slots, setSlots] = useState<FilamentSlot[]>(printer.loaded_filaments ?? []);
  const [inventory, setInventory] = useState<Filament[]>([]);
  const [editing, setEditing] = useState(false);
  const [paletteSlot, setPaletteSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Filament[]>("/api/materials").then(setInventory).catch(() => {});
  }, []);

  function addSlot() {
    setSlots((prev) => [
      ...prev,
      { slot: prev.length, color: "#888888", color_name: null, type: "PLA", brand: null, filament_id: null, empty: false, unit_id: null },
    ]);
  }

  function removeSlot(i: number) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, slot: idx })));
  }

  function update(i: number, patch: Partial<FilamentSlot>) {
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function pickFromInventory(i: number, filamentId: number | null) {
    if (filamentId === null) { update(i, { filament_id: null }); return; }
    const f = inventory.find((x) => x.id === filamentId);
    if (!f) return;
    update(i, {
      filament_id: f.id,
      color: f.hex_color ?? colorHex(f.color),
      color_name: f.color,
      type: f.material,
      brand: f.brand ?? null,
    });
  }

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api(`/api/printers/${printer.id}/loaded-filaments`, {
        method: "PUT",
        body: JSON.stringify(slots),
      });
      onUpdated();
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* ── palette modal ── */}
      {paletteSlot !== null && (
        <ColorPaletteModal
          slotLabel={`#${paletteSlot + 1}`}
          onPick={(c) => update(paletteSlot, { color: c.hex_color, color_name: c.name, filament_id: null })}
          onClose={() => setPaletteSlot(null)}
        />
      )}

      <Card title="Пластик в принтері">
        {slots.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <EmptySpoolIcon size={56} />
            <p className="text-sm text-[var(--text-faint)]">Пластик не вказано</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {slots.map((s, i) => {
              const invItem = s.filament_id ? inventory.find((f) => f.id === s.filament_id) : null;
              const isActive = printer.active_tray === s.slot;
              return (
                <div
                  key={i}
                  className={[
                    "relative grid grid-cols-[auto_1fr] items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                    isActive ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-[var(--surface-2)]",
                  ].join(" ")}
                >
                  {isActive && (
                    <span className="absolute right-2 top-2 size-1.5 rounded-full" style={{ background: "var(--accent)" }} />
                  )}
                  <SpoolIcon color={s.color} size={32} />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--text)] ">
                      {s.color_name ? `${s.type} · ${s.color_name}` : s.type}
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--text-faint)]">
                      <span>#{i + 1}{s.brand ? ` · ${s.brand}` : ""}</span>
                      {invItem && <span className="text-[var(--text-muted)]">· {invItem.grams_remaining} г</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── status / action bar ── */}
        <div className="mt-3 flex items-center gap-3">
          {saved && <span className="text-sm text-[var(--state-ok)]">✓ Збережено</span>}
          {err && <span className="text-sm text-[var(--state-error)]">{err}</span>}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]   "
            >
              Редагувати
            </button>
          )}
        </div>

        {/* ── edit panel ── */}
        {canEdit && editing && (
          <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-4 ">
            {slots.map((s, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2 "
              >
                {/* slot number */}
                <span className="w-5 shrink-0 text-center text-xs text-[var(--text-faint)]">#{i + 1}</span>

                {/* colour swatch — click opens palette modal, hold for native picker */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    title="Вибрати з палітри"
                    onClick={() => setPaletteSlot(i)}
                    className="size-7 rounded-full ring-2 ring-neutral-300 hover:ring-neutral-600  dark:hover:ring-neutral-300"
                    style={{ backgroundColor: colorHex(s.color) }}
                  />
                  {/* native picker for custom hex */}
                  <div className="relative" title="Власний HEX">
                    <span className="flex size-5 items-center justify-center rounded border border-[var(--border)] text-[10px] text-[var(--text-faint)] ">#</span>
                    <input
                      type="color"
                      value={colorHex(s.color)}
                      onChange={(e) => update(i, { color: e.target.value, color_name: null, filament_id: null })}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                  </div>
                </div>

                {/* explicit HEX */}
                <input
                  type="text"
                  value={s.color}
                  onChange={(e) => update(i, { color: e.target.value, color_name: null, filament_id: null })}
                  onBlur={() => update(i, { color: normalizeHex(s.color) || "#888888" })}
                  placeholder="#RRGGBB"
                  maxLength={7}
                  className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-xs uppercase outline-none"
                  title="HEX колір"
                />

                {/* color name badge */}
                {s.color_name && (
                  <span className="rounded bg-[var(--surface-hi)] px-1.5 py-0.5 text-[10px] ">{s.color_name}</span>
                )}

                {/* type */}
                <select
                  value={s.type}
                  onChange={(e) => update(i, { type: e.target.value })}
                  className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm  "
                >
                  {PRESET_TYPES.map((t) => <option key={t}>{t}</option>)}
                  {!PRESET_TYPES.includes(s.type) && <option value={s.type}>{s.type}</option>}
                </select>

                {/* brand */}
                <input
                  type="text"
                  value={s.brand ?? ""}
                  onChange={(e) => update(i, { brand: e.target.value || null })}
                  placeholder="Виробник"
                  className="w-28 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none  "
                />

                {/* inventory link */}
                {inventory.length > 0 && (
                  <select
                    value={s.filament_id ?? ""}
                    onChange={(e) => pickFromInventory(i, e.target.value ? Number(e.target.value) : null)}
                    className="max-w-[160px] rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs  "
                    title="Зв'язати з інвентарем"
                  >
                    <option value="">— Інвентар —</option>
                    {inventory.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.material} {f.color} {f.hex_color ? `· ${f.hex_color}` : ""} {f.brand ? `· ${f.brand}` : ""}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() => removeSlot(i)}
                  className="ml-auto rounded px-2 py-1 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                >
                  ✕
                </button>
              </div>
            ))}

            {/* actions */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={addSlot}
                className="rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] "
              >
                + Додати слот
              </button>

              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50  "
              >
                {busy ? "Зберігаю…" : "Зберегти"}
              </button>

              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]  "
              >
                Скасувати
              </button>

              {err && <span className="text-sm text-[var(--state-error)]">{err}</span>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function U1SlotsCard({
  printer,
  onUpdated,
}: {
  printer: Printer;
  onUpdated: () => void;
}) {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator";
  
  const [slots, setSlots] = useState<PrinterSlotInfo[]>(printer.slots ?? []);
  const [inventory, setInventory] = useState<Filament[]>([]);
  const [editing, setEditing] = useState(false);
  const [paletteSlot, setPaletteSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setSlots(printer.slots ?? []);
  }, [printer.slots]);

  useEffect(() => {
    if (editing && inventory.length === 0) {
      api<Filament[]>("/api/materials").then(setInventory).catch(() => {});
    }
  }, [editing, inventory.length]);

  function updateDraft(slotIdx: number, patch: Partial<PrinterSlotInfo>) {
    setSlots((prev) => prev.map((s) => (s.slot_index === slotIdx ? { ...s, ...patch } : s)));
  }

  function pickFromInventory(slotIdx: number, filamentId: number | null) {
    if (filamentId === null) { updateDraft(slotIdx, { filament_id: null }); return; }
    const f = inventory.find((x) => x.id === filamentId);
    if (!f) return;
    updateDraft(slotIdx, {
      filament_id: f.id,
      color: f.hex_color ?? colorHex(f.color),
      hex_color: f.hex_color ?? colorHex(f.color),
      material: f.material,
      brand: f.brand ?? null,
    });
  }

  function clearSlot(slotIdx: number) {
    updateDraft(slotIdx, {
      filament_id: null,
      material: null,
      color: null,
      hex_color: null,
      brand: null,
    });
  }

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await Promise.all(
        slots.map((s) =>
          api(`/api/printers/${printer.id}/slots/${s.slot_index}`, {
            method: "PUT",
            body: JSON.stringify({
              filament_id: s.filament_id,
              material: s.material || null,
              color: s.color || null,
              hex_color: s.hex_color || null,
              brand: s.brand || null,
            }),
          })
        )
      );
      onUpdated();
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {paletteSlot !== null && (
        <ColorPaletteModal
          slotLabel={`T${paletteSlot + 1}`}
          onPick={(c) => updateDraft(paletteSlot, { hex_color: c.hex_color, color: c.name, filament_id: null })}
          onClose={() => setPaletteSlot(null)}
        />
      )}

      <Card title="Пластик в принтері">
        {slots.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <EmptySpoolIcon size={56} />
            <p className="text-sm text-[var(--text-faint)]">Пластик не вказано</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {slots.map((s) => {
                const hex = colorHex(s.hex_color ?? s.color);
                const empty = s.state === "empty" || !s.filament_id;
                const invItem = s.filament_id ? inventory.find((f) => f.id === s.filament_id) : null;
                return (
                  <div
                    key={s.slot_index}
                    className="grid grid-cols-[auto_1fr] items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
                  >
                    <SpoolIcon color={empty ? "#888888" : hex} size={32} />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-[var(--text)]">
                        {empty ? "—" : [s.material, s.color].filter(Boolean).join(" · ")}
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--text-faint)]">
                        <span>T{s.slot_index + 1}</span>
                        {!empty && <span className="uppercase">· {s.hex_color ?? hex}</span>}
                        {invItem && <span className="text-[var(--text-muted)]">· {invItem.grams_remaining} г</span>}
                      </div>
                      {!empty && s.brand && (
                        <div className="truncate text-[10px] text-[var(--text-faint)]">{s.brand}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          {saved && <span className="text-sm text-[var(--state-ok)]">✓ Збережено</span>}
          {err && <span className="text-sm text-[var(--state-error)]">{err}</span>}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
            >
              Редагувати
            </button>
          )}
        </div>

        {canEdit && editing && (
          <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-4">
            {slots.map((s) => (
              <div
                key={s.slot_index}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2"
              >
                <span className="w-6 shrink-0 text-center font-mono text-xs text-[var(--text-faint)]">
                  T{s.slot_index + 1}
                </span>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    title="Вибрати з палітри"
                    onClick={() => setPaletteSlot(s.slot_index)}
                    className="size-7 rounded-full ring-2 ring-neutral-300 hover:ring-neutral-600 dark:hover:ring-neutral-300"
                    style={{ backgroundColor: colorHex(s.hex_color ?? s.color) }}
                  />
                  <div className="relative" title="Власний HEX">
                    <span className="flex size-5 items-center justify-center rounded border border-[var(--border)] text-[10px] text-[var(--text-faint)]">#</span>
                    <input
                      type="color"
                      value={colorHex(s.hex_color ?? s.color)}
                      onChange={(e) => updateDraft(s.slot_index, { hex_color: e.target.value, filament_id: null })}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                  </div>
                </div>

                <input
                  type="text"
                  value={s.hex_color ?? s.color ?? ""}
                  onChange={(e) => updateDraft(s.slot_index, { hex_color: e.target.value, filament_id: null })}
                  onBlur={() => updateDraft(s.slot_index, { hex_color: normalizeHex(s.hex_color ?? s.color ?? "") || "#888888" })}
                  placeholder="#RRGGBB"
                  maxLength={7}
                  className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-xs uppercase outline-none"
                  title="HEX колір"
                />

                <select
                  value={s.material ?? ""}
                  onChange={(e) => updateDraft(s.slot_index, { material: e.target.value || null })}
                  className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm"
                >
                  <option value="">—</option>
                  {PRESET_TYPES.map((t) => <option key={t}>{t}</option>)}
                  {s.material && !PRESET_TYPES.includes(s.material) && <option value={s.material}>{s.material}</option>}
                </select>

                <input
                  type="text"
                  value={s.brand ?? ""}
                  onChange={(e) => updateDraft(s.slot_index, { brand: e.target.value || null })}
                  placeholder="Виробник"
                  className="w-28 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-sm outline-none"
                />

                {inventory.length > 0 && (
                  <select
                    value={s.filament_id ?? ""}
                    onChange={(e) => pickFromInventory(s.slot_index, e.target.value ? Number(e.target.value) : null)}
                    className="max-w-[160px] rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs"
                    title="Зв'язати з інвентарем"
                  >
                    <option value="">— Інвентар —</option>
                    {inventory.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.material} {f.color} {f.hex_color ? `· ${f.hex_color}` : ""} {f.brand ? `· ${f.brand}` : ""}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() => clearSlot(s.slot_index)}
                  className="ml-auto rounded px-2 py-1 text-xs text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
                  title="Очистити слот"
                >
                  ✕
                </button>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50"
              >
                {busy ? "Зберігаю…" : "Зберегти"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]"
              >
                Скасувати
              </button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}


// ── connection card ───────────────────────────────────────────────────────────

function fmtRelative(value: string | null): string {
  if (!value) return "—";
  const sec = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (sec < 60) return `${sec} с тому`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} хв тому`;
  const hr = Math.round(min / 60);
  return `${hr} год тому`;
}

const HEALTH_TONE_COLOR: Record<HealthTone, string> = {
  ok: "var(--state-ok)",
  warn: "var(--state-warn)",
  bad: "var(--state-error)",
  muted: "var(--state-offline)",
};

function ConnectionCard({ printer }: { printer: Printer }) {
  const isBambu = printer.kind === "bambu";
  const hasMoonraker = !!printer.moonraker_url;
  const health = healthSummary(printer);

  const rows: { k: string; v: React.ReactNode }[] = [
    { k: "Бекенд", v: transportLabel(printer) },
  ];
  if (isBambu && printer.bambu_model) rows.push({ k: "Модель", v: printer.bambu_model });
  if (isBambu && printer.bambu_dev_id) rows.push({ k: "Серійний", v: <span className="font-mono">{printer.bambu_dev_id}</span> });
  if (printer.bambu_dev_ip) rows.push({ k: "IP · LAN", v: <span className="font-mono">{printer.bambu_dev_ip}</span> });
  if (hasMoonraker) {
    rows.push({
      k: "Moonraker",
      v: (
        <a href={printer.moonraker_url!} target="_blank" rel="noopener noreferrer" className="font-mono text-[var(--accent)] hover:underline">
          {printer.moonraker_url}
        </a>
      ),
    });
  }
  if (printer.source !== "manual") {
    rows.push({ k: "Останній звіт", v: fmtRelative(printer.updated_at) });
  }

  return (
    <Card title="Підключення та діагностика">
      {/* ── unified health summary — same shape for every backend ── */}
      <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
        <StatusDot color={HEALTH_TONE_COLOR[health.tone]} ping={health.tone === "ok"} />
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--text)]">{health.label}</p>
          {health.detail && <p className="truncate text-[11px] text-[var(--text-faint)]">{health.detail}</p>}
        </div>
      </div>

      {printer.source === "manual" ? (
        <p className="text-xs text-[var(--text-faint)]">
          Цей принтер не підключений напряму — стан і завдання вносяться вручну.
        </p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {rows.map((r) => (
            <div key={r.k} className="flex items-center justify-between gap-3 py-2 text-xs first:pt-0 last:pb-0">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]">{r.k}</span>
              <span className="truncate text-right text-[var(--text)]">{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── print history card ────────────────────────────────────────────────────────

interface PrinterHistoryEntry {
  id: number;
  file_name: string | null;
  started_at: string;
  duration_minutes: number | null;
  result: string;
  filament_g: number | null;
  source: string | null;
}

function fmtHistTime(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "сьогодні";
  if (days === 1) return "вчора";
  return `${days} дн тому`;
}

function fmtHistDuration(min: number | null): string {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} г ${m} хв` : `${m} хв`;
}

function PrintHistoryCard({ printer }: { printer: Printer }) {
  const [entries, setEntries] = useState<PrinterHistoryEntry[] | null>(null);

  useEffect(() => {
    api<PrinterHistoryEntry[]>(`/api/history?printer_id=${printer.id}&limit=8`)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [printer.id]);

  if (!entries || entries.length === 0) return null;

  const successCount = entries.filter((e) => e.result === "completed").length;
  const successPct = Math.round((successCount / entries.length) * 100);

  return (
    <Card title="Історія друку">
      <div className="-mt-1 mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{entries.length} записів · {successPct}% успішно</span>
        <Link href="/history" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] ">Усі →</Link>
      </div>
      <ul className="-mx-5 divide-y divide-[var(--border)]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-xs">
            <span className={`size-1.5 shrink-0 rounded-full ${
              e.result === "completed" ? "bg-[var(--state-ok)]" : e.result === "failed" ? "bg-[var(--state-error)]" : "bg-[var(--text-dim)]"
            }`} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11.5px] text-[var(--text)]">{e.file_name ?? "—"}</p>
              {(e.filament_g != null || e.source) && (
                <p className="font-mono text-[10px] text-[var(--text-faint)]">
                  {[e.filament_g != null ? `${Math.round(e.filament_g)} г` : null, e.source].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-faint)]">{fmtHistDuration(e.duration_minutes)}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-dim)]">{fmtHistTime(e.started_at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── settings card ─────────────────────────────────────────────────────────────

function SettingsCard({
  printer,
  onUpdated,
  onDeleted,
}: {
  printer: Printer;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const user = useUser();
  const [groups, setGroups] = useState<PrinterGroup[]>([]);
  // Initialise form once from printer snapshot — intentionally not synced on
  // every background refresh so the user's in-progress edits aren't overwritten.
  const [name, setName] = useState(printer.name);
  const [url, setUrl] = useState(printer.moonraker_url ?? "");
  const [bambuIp, setBambuIp] = useState(printer.bambu_dev_ip ?? "");
  const [groupId, setGroupId] = useState<string>(printer.group_id?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api<PrinterGroup[]>("/api/printer-groups").then(setGroups).catch(() => {});
  }, []);

  if (user.role !== "admin") return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      if (
        name !== printer.name ||
        url !== (printer.moonraker_url ?? "") ||
        bambuIp !== (printer.bambu_dev_ip ?? "")
      ) {
        await api(`/api/printers/${printer.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim() || undefined,
            moonraker_url: url.trim() || null,
            bambu_dev_ip: bambuIp.trim() || null,
          }),
        });
      }
      const newGroupId = groupId ? parseInt(groupId) : null;
      if (newGroupId !== printer.group_id) {
        await api(`/api/printers/${printer.id}/group`, {
          method: "POST",
          body: JSON.stringify({ group_id: newGroupId }),
        });
      }
      onUpdated();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка збереження");
    } finally {
      setBusy(false);
    }
  }

  async function deletePrinter() {
    try {
      await api(`/api/printers/${printer.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка видалення");
      setConfirmDelete(false);
    }
  }

  return (
    <Card title="Налаштування">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--text-muted)]">Назва</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)]"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-[var(--text-muted)]">Група</span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none  "
            >
              <option value="">— Без групи —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>

          {printer.kind === "bambu" && (
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">LAN IP (для камери)</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={bambuIp}
                  onChange={(e) => setBambuIp(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)]"
                />
              </div>
            </label>
          )}

          {printer.kind !== "bambu" && (
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--text-muted)]">Moonraker URL</span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://192.168.31.210"
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--border-focus)]"
              />
            </label>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hi)] disabled:opacity-50   "
          >
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
          {saved && <span className="text-sm text-[var(--state-ok)]">✓ Збережено</span>}
          {err && <span className="text-sm text-[var(--state-error)]">{err}</span>}

          <div className="flex-1" />

          {true && (
            confirmDelete ? (
              <div className="flex items-center gap-2 rounded-lg border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] px-3 py-1.5">
                <span className="text-sm text-[var(--state-error)]">Видалити {printer.name}?</span>
                <button type="button" onClick={deletePrinter} className="rounded px-2 py-0.5 text-sm font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.12)]">Так</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">Ні</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg border border-[var(--state-error)] px-4 py-2 text-sm text-[var(--state-error)] hover:bg-[rgba(239,68,68,.08)]"
              >
                Видалити принтер
              </button>
            )
          )}
        </div>
      </form>
    </Card>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function PrinterPage() {
  const params = useParams();
  const router = useRouter();
  const printerId = Number(params.id);

  const { printers, loading, reload } = usePrinterStream();
  const printer = printers.find((p) => p.id === printerId) ?? null;
  const error = !loading && !printer ? "Принтер не знайдено" : null;
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--text-muted)]">
        Завантаження…
      </div>
    );
  }

  if (error || !printer) {
    return (
      <div className="space-y-3">
        <Link href="/printers" className="text-sm text-[var(--text-muted)] hover:text-[var(--text-hi)] ">
          ← Назад
        </Link>
        <div className="rounded-lg border border-[rgba(239,68,68,.2)] bg-[rgba(239,68,68,.08)] px-4 py-3 text-sm text-[var(--state-error)]">
          {error ?? "Принтер не знайдено"}
        </div>
      </div>
    );
  }

  const isBambu = printer.kind === "bambu";

  return (
    <div className="space-y-4">
      {/* ── header ── */}
      <div className="space-y-3 border-b border-[var(--border)] pb-4 ">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <Link href="/dashboard"
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-faint)] transition hover:border-[var(--border-strong)] hover:text-[var(--text)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold text-[var(--text-hi)]">{printer.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-faint)]">
                <span className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <span className="size-1.5 rounded-full" style={{ background: "var(--state-ok)" }} />
                  {transportLabel(printer)}
                </span>
                <span>{kindLabel(printer.kind)}</span>
                {printer.bambu_model && <><span className="text-[var(--text-dim)]">·</span><span>{printer.bambu_model}</span></>}
                {printer.bambu_dev_id && <><span className="text-[var(--text-dim)]">·</span><span className="font-mono text-[11px]">{printer.bambu_dev_id}</span></>}
                {printer.bambu_dev_ip && <><span className="text-[var(--text-dim)]">·</span><span className="font-mono text-[11px]">{printer.bambu_dev_ip}</span></>}
                {printer.group_name && <><span className="text-[var(--text-dim)]">·</span><span>{printer.group_name}</span></>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {printer.flags?.map((f) => (
              <span key={f} className="badge badge-warn text-[10px]">{flagLabel(f)}</span>
            ))}
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-2.5 pr-3 text-xs text-[var(--text)]">
              <StatusDot color={TONE_COLOR[printerTone(printer)] ?? "var(--state-idle)"} ping={printer.state === "printing"} />
              <span>
                {stateLabel(printer.state)}
                {printer.state === "printing" && formatEta(printer.eta_minutes) ? ` · ще ${formatEta(printer.eta_minutes)}` : ""}
              </span>
            </div>
            <button onClick={() => void reload()}
              className="flex size-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]"
              title="Оновити">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
            <button onClick={() => setSettingsOpen(true)}
              className="flex size-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]"
              title="Налаштування принтера">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── main grid — 2 columns ── */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">

        {/* Col 1 — job, filaments, movement */}
        <div className="min-w-0 space-y-4">
          <JobHeroCard printer={printer} onUpdated={reload} />
          {printer.current_filament_meta && <FilamentCard printer={printer} />}
          {printer.kind === "snapmaker_u1" ? (
            <U1SlotsCard printer={printer} onUpdated={reload} />
          ) : (
            <LoadedFilamentsCard printer={printer} onUpdated={reload} />
          )}
          <JogCard printer={printer} />
        </div>

        {/* Col 2 — temps, speed, connection, jobs, history */}
        <div className="min-w-0 space-y-4">
          <TemperaturesCard printer={printer} />
          <SpeedCard printer={printer} />
          <ConnectionCard printer={printer} />
          {((isBambu && printer.bambu_dev_id) || !!printer.moonraker_url) && <BambuJobsCard printer={printer} />}
          <PrintHistoryCard printer={printer} />
        </div>
      </div>

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-12 backdrop-blur-sm"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl  "
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4 ">
              <div>
                <h2 className="font-semibold">{printer.name}</h2>
                <p className="text-xs text-[var(--text-faint)]">Налаштування принтера</p>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--surface-hi)] hover:text-[var(--text)]  "
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div className="p-6">
              <SettingsCard
                printer={printer}
                onUpdated={() => { reload(); setSettingsOpen(false); }}
                onDeleted={() => router.push("/printers")}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
