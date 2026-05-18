"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { API_URL, ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateLabel,
} from "@/lib/printerLabels";
import { StateIcon } from "@/components/StateIcon";
import type { Filament, FilamentColor, FilamentSlot, Printer, PrinterGroup } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${m} хв` : `${h} год`;
}


function Card({ title, children, className = "", accent }: { title?: string; children: React.ReactNode; className?: string; accent?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>
      {accent && <div className={`absolute inset-y-0 left-0 w-1 ${accent}`} />}
      <div className={accent ? "pl-5 pr-5 py-5" : "p-5"}>
        {title && <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-500">{title}</p>}
        {children}
      </div>
    </div>
  );
}

// ── camera ────────────────────────────────────────────────────────────────────

function CameraCard({ printer }: { printer: Printer }) {
  const isBambu = printer.kind === "bambu" && !!printer.bambu_dev_ip;
  const [open, setOpen]       = useState(false);
  const [error, setError]     = useState(false);
  const [tick, setTick]       = useState(0);
  const token = getToken();

  // Moonraker snapshot poll — only while open
  useEffect(() => {
    if (!open || isBambu) return;
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, [open, isBambu]);

  // Reset error state when reopened
  useEffect(() => { if (open) setError(false); }, [open]);

  const src = isBambu
    ? `${API_URL}/api/printers/${printer.id}/camera/stream?token=${token}`
    : `${API_URL}/api/printers/${printer.id}/webcam/snapshot?t=${tick}&token=${token}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950 dark:border-neutral-800">
      {/* toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-neutral-800/50 transition"
      >
        <div className="flex items-center gap-1.5">
          {open && !error
            ? <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
            : <span className="size-1.5 rounded-full bg-neutral-600" />}
          <span className="text-[10px] font-medium text-neutral-400">
            {open && !error ? "LIVE" : "Camera"}
          </span>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {/* stream — only mounted when open */}
      {open && (
        error ? (
          <div className="flex flex-col items-center gap-2 py-6 text-neutral-500">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.82V15.18a1 1 0 01-1.447.89L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            </svg>
            <span className="text-[11px]">Camera unavailable</span>
            <button onClick={() => setError(false)}
              className="text-[10px] text-neutral-400 underline hover:text-neutral-200">
              Retry
            </button>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt="Camera"
            className="w-full object-cover"
            onError={() => setError(true)}
          />
        )
      )}
    </div>
  );
}

// ── temperatures ──────────────────────────────────────────────────────────────


function TemperaturesCard({ printer }: { printer: Printer }) {
  const rows = [
    {
      label: "Сопло",
      icon: "nozzle",
      current: printer.extruder_temp,
      target: printer.extruder_target,
    },
    {
      label: "Стіл",
      icon: "bed",
      current: printer.bed_temp,
      target: printer.bed_target,
    },
  ].filter((r) => r.current != null);

  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-neutral-100 px-5 py-3 dark:border-neutral-800">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-500">Температури</p>
      </div>
      <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
        {rows.map((r) => {
          const max = r.target ? Math.max(r.target, r.current!, 30) : Math.max(r.current!, 30);
          const pct = Math.min(100, (r.current! / max) * 100);
          const isHot = r.current! > (r.target ?? 0) * 0.8 && r.current! > 40;
          return (
            <div key={r.label} className="px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {r.icon === "nozzle" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
                      <path d="M12 22V12M8 22h8M9 12h6M12 2v4M9 6h6"/><path d="M7 6a5 5 0 0 0 10 0"/>
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
                      <rect x="2" y="14" width="20" height="6" rx="1"/><path d="M6 14v-4a6 6 0 0 1 12 0v4"/>
                    </svg>
                  )}
                  <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">{r.label}</span>
                </div>
                <div className="font-mono text-sm font-bold">
                  <span className={isHot ? "text-orange-600 dark:text-orange-400" : "text-neutral-700 dark:text-neutral-300"}>
                    {Math.round(r.current!)}°
                  </span>
                  {r.target != null && r.target > 0 && (
                    <span className="ml-1.5 text-xs font-normal text-neutral-400">→ {Math.round(r.target)}°</span>
                  )}
                </div>
              </div>
              {/* Segmented gauge */}
              <div className="flex gap-px">
                {Array.from({ length: 20 }).map((_, i) => {
                  const filled = (i / 20) * 100 < pct;
                  return (
                    <div
                      key={i}
                      className={`h-1.5 flex-1 rounded-sm transition-colors duration-300 ${
                        filled
                          ? pct > 90 ? "bg-red-500" : pct > 70 ? "bg-orange-400" : "bg-orange-300"
                          : "bg-neutral-100 dark:bg-neutral-800"
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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

function ControlPanel({ printer }: { printer: Printer }) {
  const user = useUser();
  const [dist, setDist] = useState(10);
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

  // Mechanical arrow button — tactile feel
  const axisBtn = (dir: string, script: string, key: string, svgPath: string) => (
    <button
      type="button"
      onClick={() => gcode(script, key)}
      disabled={busy !== null}
      title={`${dir} ${dist}мм`}
      className="flex size-10 items-center justify-center rounded-md border border-neutral-300 bg-neutral-50 text-neutral-600 shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] transition active:shadow-none active:translate-y-px hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
    >
      {busy === key ? (
        <span className="text-[10px]">…</span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      className="flex size-10 items-center justify-center rounded-md border border-neutral-300 bg-white text-neutral-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:border-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
      title={`Home ${label}`}
    >
      {busy === key ? (
        <span className="text-[10px]">…</span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>
        </svg>
      )}
    </button>
  );

  const utilBtn = (label: string, script: string, key: string, icon: string, colorCls = "text-neutral-600 dark:text-neutral-300") => (
    <button
      type="button"
      onClick={() => gcode(script, key)}
      disabled={busy !== null}
      className={`flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700 ${colorCls}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={icon} />
      </svg>
      {busy === key ? "…" : label}
    </button>
  );

  const SPEED_COLORS = [
    "border-neutral-300 bg-neutral-50 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300",
    "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300",
    "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300",
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3 dark:border-neutral-800">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400 dark:text-neutral-500">Керування</p>
        <span className="text-[10px] text-neutral-300 dark:text-neutral-600">{isBambu ? "Bambu MQTT" : "Moonraker"}</span>
      </div>

      <div className="p-5 space-y-5">
        {/* ── Movement ── */}
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Переміщення</p>

          {/* Step size */}
          <div className="mb-4 flex items-center gap-px overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700 w-fit">
            {MOVE_DISTANCES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDist(d)}
                className={`px-3 py-1.5 text-[11px] font-medium tabular-nums transition ${
                  dist === d
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "bg-white text-neutral-500 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
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
              <p className="mb-2 text-[9px] uppercase tracking-widest text-neutral-300 dark:text-neutral-600">X / Y</p>
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
              <p className="mb-2 text-[9px] uppercase tracking-widest text-neutral-300 dark:text-neutral-600">Z</p>
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
                className="flex flex-col items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-[10px] font-medium text-neutral-500 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>
                </svg>
                {busy === "home-all" ? "…" : "Всі"}
              </button>
            </div>
          </div>
        </div>

        <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

        {/* ── Speed ── */}
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Швидкість друку</p>
          {isBambu ? (
            <div className="grid grid-cols-4 gap-2">
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
            <div className="flex items-center gap-2">
              <input
                type="number" min={10} max={300} value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-20 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-center font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-xs text-neutral-400">%</span>
              <button
                type="button"
                onClick={() => gcode(`M220 S${speed}`, "speed")}
                disabled={busy !== null}
                className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              >
                {busy === "speed" ? "…" : "Задати"}
              </button>
            </div>
          )}
        </div>

        {/* ── Flow (Moonraker) ── */}
        {isMoonraker && (
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Витрата пластику</p>
            <div className="flex items-center gap-2">
              <input
                type="number" min={50} max={200} value={flow}
                onChange={(e) => setFlow(Number(e.target.value))}
                className="w-20 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-center font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span className="text-xs text-neutral-400">%</span>
              <button
                type="button"
                onClick={() => gcode(`M221 S${flow}`, "flow")}
                disabled={busy !== null}
                className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              >
                {busy === "flow" ? "…" : "Задати"}
              </button>
            </div>
          </div>
        )}

        <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

        {/* ── Utilities ── */}
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">Допоміжні</p>
          <div className="flex flex-wrap gap-2">
            {utilBtn("Мотори вимк", "M84", "motors-off", "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18")}
            {utilBtn("Вент увімк", "M106 S255", "fan-on", "M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2 2 0 1 1 19.5 12H2")}
            {utilBtn("Вент вимк", "M107", "fan-off", "M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2 2 0 1 1 19.5 12H2")}
            {utilBtn("Охолодити", "M104 S0\nM140 S0", "cool-down", "M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "text-blue-600 dark:text-blue-400")}
          </div>
        </div>

        {err && <p className="text-xs text-red-500 dark:text-red-400">{err}</p>}
      </div>
    </div>
  );
}

function PrintStatusCard({
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

  const tone = printerTone(printer);
  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const isOperational = printer.state === "operational" || printer.state === "awaiting_bed_clear";
  const isError = printer.state === "error";
  const hasMoonraker = !!printer.moonraker_url;
  const eta = formatEta(printer.eta_minutes);

  async function act(action: string) {
    if (busy) return;
    setBusy(action);
    setErr(null);
    setConfirmCancel(false);
    try {
      await api(`/api/printers/${printer.id}/print/${action}`, { method: "POST" });
      onUpdated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка");
    } finally {
      setBusy(null);
    }
  }

  const stateBarColor = {
    printing: "bg-blue-500", ok: "bg-emerald-500", warn: "bg-amber-400",
    bad: "bg-red-500", idle: "bg-neutral-300 dark:bg-neutral-600", muted: "bg-neutral-200",
  }[tone] ?? "bg-neutral-300";

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {/* State bar — 3px color accent across top */}
      <div className={`h-0.5 w-full ${stateBarColor}`} />

      <div className="p-5">
        {/* State row */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <StateIcon state={printer.state} size={16} />
            <span className="text-sm font-semibold">{stateLabel(printer.state)}</span>
            {printer.flags?.map((f) => (
              <span key={f} className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                {flagLabel(f)}
              </span>
            ))}
          </div>
          <span className="font-mono text-[10px] text-neutral-300 dark:text-neutral-600 uppercase">{kindLabel(printer.kind)}</span>
        </div>

        {/* Error strip */}
        {printer.error_msg && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/50 dark:bg-red-900/10">
            <svg className="mt-0.5 shrink-0 text-red-500" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p className="text-xs text-red-700 dark:text-red-400">{printer.error_msg}</p>
          </div>
        )}

        {/* Job + progress */}
        {(printer.job || isPrinting || isPaused) && (
          <div className="mb-5 rounded-md border border-neutral-100 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-800/50">
            {printer.job && (
              <p className="mb-1 truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">{printer.job}</p>
            )}
            {eta && (
              <p className="mb-2.5 font-mono text-[11px] text-neutral-400">⏱ {eta} залишилось</p>
            )}
            {printer.progress_pct != null && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-[10px] text-neutral-400">прогрес</span>
                  <span className="font-mono text-sm font-bold tabular-nums text-blue-600 dark:text-blue-400">
                    {printer.progress_pct}%
                  </span>
                </div>
                <div className="relative h-3 overflow-hidden rounded-sm bg-neutral-200 dark:bg-neutral-700">
                  <div
                    className="h-full bg-blue-500 transition-[width] duration-1000 ease-linear"
                    style={{ width: `${printer.progress_pct}%` }}
                  />
                  {/* Tick marks */}
                  {[25, 50, 75].map((t) => (
                    <div key={t} className="absolute inset-y-0 w-px bg-white/30 dark:bg-black/20" style={{ left: `${t}%` }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {isPrinting && (
              <button onClick={() => act("pause")} disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-700 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-amber-100 disabled:opacity-40 dark:border-amber-900/50 dark:bg-amber-900/10 dark:text-amber-300">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                {busy === "pause" ? "…" : "Пауза"}
              </button>
            )}
            {isPaused && (
              <button onClick={() => act("resume")} disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-700 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-900/50 dark:bg-emerald-900/10 dark:text-emerald-300">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                {busy === "resume" ? "…" : "Продовжити"}
              </button>
            )}
            {(isPrinting || isPaused) && (
              confirmCancel ? (
                <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/50 dark:bg-red-900/10">
                  <span className="text-xs text-red-700 dark:text-red-300">Зупинити друк?</span>
                  <button onClick={() => act("cancel")} disabled={busy !== null}
                    className="text-xs font-bold text-red-700 hover:underline disabled:opacity-40 dark:text-red-400">
                    {busy === "cancel" ? "…" : "Так"}
                  </button>
                  <span className="text-neutral-300">·</span>
                  <button onClick={() => setConfirmCancel(false)} className="text-xs text-neutral-500 hover:underline">Ні</button>
                </div>
              ) : (
                <button onClick={() => setConfirmCancel(true)} disabled={busy !== null}
                  className="flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-xs font-medium text-red-700 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-red-100 disabled:opacity-40 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-300">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  Зупинити
                </button>
              )
            )}
            {isOperational && (
              <button onClick={() => act("clear-bed")} disabled={busy !== null}
                className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-700 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-900/50 dark:bg-emerald-900/10 dark:text-emerald-300">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                {busy === "clear-bed" ? "…" : "Стіл очищено"}
              </button>
            )}
            {isError && (
              <button onClick={() => act("clear-error")} disabled={busy !== null}
                className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-medium text-neutral-600 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {busy === "clear-error" ? "…" : "Скинути помилку"}
              </button>
            )}
            {isPrinting && hasMoonraker && (
              <button onClick={() => act("skip-object")} disabled={busy !== null}
                title="Потребує [exclude_object] в printer.cfg"
                className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-medium text-neutral-600 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] transition hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {busy === "skip-object" ? "…" : "Пропустити об'єкт"}
              </button>
            )}
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </div>
  );
}

// ── spool icon helpers ────────────────────────────────────────────────────────

function colorHex(c: string): string {
  if (!c) return "#888888";
  return c.startsWith("#") ? c.slice(0, 7) : c;
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
        return <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.22)" strokeWidth="2.5" strokeLinecap="round" />;
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
      <circle cx={cx} cy={cx} r={r} fill="transparent" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" className="text-neutral-300 dark:text-neutral-700" />
      <circle cx={cx} cy={cx} r={r * 0.28} fill="transparent" stroke="currentColor" strokeWidth="1.5" className="text-neutral-300 dark:text-neutral-700" />
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
                  <div className="text-[10px] text-neutral-400">{grams} г</div>
                )}
                <div className="mt-0.5 text-[10px] text-neutral-400">#{i + 1}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-500">
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
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div>
            <h2 className="text-base font-semibold">Палітра кольорів</h2>
            <p className="text-xs text-neutral-500">Вибери колір для слоту {slotLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>

        {/* color grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {colors.length === 0 ? (
            <p className="py-6 text-center text-sm text-neutral-400">Збережених кольорів ще немає</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {colors.map((c) => (
                <div key={c.id} className="group relative">
                  {editingId === c.id ? (
                    /* edit row */
                    <div className="col-span-1 flex flex-col gap-1 rounded-xl border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-600 dark:bg-neutral-800">
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
                        className="w-full rounded border border-neutral-200 bg-white px-1 py-0.5 text-[10px] outline-none dark:border-neutral-700 dark:bg-neutral-950"
                        onKeyDown={(e) => e.key === "Enter" && saveEdit(c.id)}
                      />
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => saveEdit(c.id)}
                          className="flex-1 rounded bg-neutral-900 py-0.5 text-[10px] text-white dark:bg-neutral-100 dark:text-neutral-900"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="flex-1 rounded border border-neutral-200 py-0.5 text-[10px] text-neutral-500 dark:border-neutral-700"
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
                      className="flex w-full flex-col items-center gap-1.5 rounded-xl p-2 text-center hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      <span
                        className="block size-10 rounded-full ring-1 ring-black/15 dark:ring-white/15"
                        style={{ backgroundColor: c.hex_color }}
                      />
                      <span className="w-full truncate text-[11px] leading-tight text-neutral-700 dark:text-neutral-300">
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
                        className="flex size-4 items-center justify-center rounded-full bg-neutral-600 text-[8px] text-white"
                        title="Редагувати"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteColor(c.id); }}
                        className="flex size-4 items-center justify-center rounded-full bg-red-500 text-[8px] text-white"
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
        <div className="border-t border-neutral-100 p-4 dark:border-neutral-800">
          <p className="mb-2 text-xs font-medium text-neutral-500">Додати новий колір</p>
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
              className="flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-300"
              onKeyDown={(e) => e.key === "Enter" && createColor()}
            />
            <button
              type="button"
              onClick={createColor}
              disabled={busy || !newName.trim()}
              className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
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
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
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
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 shadow-sm shadow-blue-500/20"
                      : "border-neutral-100 dark:border-neutral-800",
                  ].join(" ")}
                >
                  {isActive && (
                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-bold text-white leading-none">
                      друкує
                    </span>
                  )}
                  {s.empty ? (
                    <div className="size-7 rounded-full border-2 border-dashed border-neutral-200 dark:border-neutral-700" />
                  ) : (
                    <div
                      className="size-7 rounded-full ring-2 ring-black/10 dark:ring-white/10"
                      style={{ backgroundColor: hex }}
                    />
                  )}
                  <div className="w-full text-center">
                    <div className="truncate text-[11px] font-semibold leading-tight text-neutral-700 dark:text-neutral-300">
                      {s.empty ? "—" : (s.type || "?")}
                    </div>
                    {invItem && (
                      <div className="text-[9px] text-neutral-400">{invItem.grams_remaining} г</div>
                    )}
                    <div className="text-[9px] text-neutral-400">{label}</div>
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
          <div key={s.slot} className="flex items-center gap-3 rounded-xl border border-neutral-100 px-4 py-3 dark:border-neutral-800">
            <div
              className={`size-6 shrink-0 rounded-full ring-2 ${isActive ? "ring-blue-500" : "ring-black/10 dark:ring-white/10"}`}
              style={{ backgroundColor: hex }}
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold">{s.type || "—"}</div>
              {s.brand && <div className="text-[10px] text-neutral-400">{s.brand}</div>}
            </div>
            <span className="ml-auto text-[10px] text-neutral-400">Зовнішня</span>
            {isActive && <span className="rounded-full bg-blue-500 px-2 py-0.5 text-[9px] font-bold text-white">друкує</span>}
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
    api<Filament[]>("/api/filaments").then(setInventory).catch(() => {});
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
    update(i, { filament_id: f.id, color: colorHex(f.color), color_name: null, type: f.material, brand: f.brand ?? null });
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
            <p className="text-sm text-neutral-400">Пластик не вказано</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-5">
            {slots.map((s, i) => {
              const invItem = s.filament_id ? inventory.find((f) => f.id === s.filament_id) : null;
              return (
                <div key={i} className="flex flex-col items-center gap-1.5 text-center">
                  <SpoolIcon color={s.color} size={72} />
                  <div className="max-w-[84px]">
                    {s.color_name && <div className="truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-300">{s.color_name}</div>}
                    <div className="text-xs font-semibold leading-tight">{s.type}</div>
                    {s.brand && <div className="truncate text-[10px] text-neutral-500">{s.brand}</div>}
                    {invItem && <div className="text-[10px] text-neutral-400">{invItem.grams_remaining} г</div>}
                    <div className="mt-0.5 text-[10px] text-neutral-400">#{i + 1}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── status / action bar ── */}
        <div className="mt-3 flex items-center gap-3">
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">✓ Збережено</span>}
          {err && <span className="text-sm text-red-500">{err}</span>}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Редагувати
            </button>
          )}
        </div>

        {/* ── edit panel ── */}
        {canEdit && editing && (
          <div className="mt-4 space-y-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            {slots.map((s, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-100 p-2 dark:border-neutral-800"
              >
                {/* slot number */}
                <span className="w-5 shrink-0 text-center text-xs text-neutral-400">#{i + 1}</span>

                {/* colour swatch — click opens palette modal, hold for native picker */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    title="Вибрати з палітри"
                    onClick={() => setPaletteSlot(i)}
                    className="size-7 rounded-full ring-2 ring-neutral-300 hover:ring-neutral-600 dark:ring-neutral-600 dark:hover:ring-neutral-300"
                    style={{ backgroundColor: colorHex(s.color) }}
                  />
                  {/* native picker for custom hex */}
                  <div className="relative" title="Власний HEX">
                    <span className="flex size-5 items-center justify-center rounded border border-neutral-200 text-[10px] text-neutral-400 dark:border-neutral-700">#</span>
                    <input
                      type="color"
                      value={colorHex(s.color)}
                      onChange={(e) => update(i, { color: e.target.value, color_name: null, filament_id: null })}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                  </div>
                </div>

                {/* color name badge */}
                {s.color_name && (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">{s.color_name}</span>
                )}

                {/* type */}
                <select
                  value={s.type}
                  onChange={(e) => update(i, { type: e.target.value })}
                  className="rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
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
                  className="w-28 rounded border border-neutral-200 bg-white px-2 py-1 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-950"
                />

                {/* inventory link */}
                {inventory.length > 0 && (
                  <select
                    value={s.filament_id ?? ""}
                    onChange={(e) => pickFromInventory(i, e.target.value ? Number(e.target.value) : null)}
                    className="max-w-[160px] rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                    title="Зв'язати з інвентарем"
                  >
                    <option value="">— Інвентар —</option>
                    {inventory.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.material} {f.color} {f.brand ? `· ${f.brand}` : ""}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={() => removeSlot(i)}
                  className="ml-auto rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
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
                className="rounded-lg border border-dashed border-neutral-300 px-3 py-1.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-700 dark:border-neutral-700 dark:hover:border-neutral-500"
              >
                + Додати слот
              </button>

              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {busy ? "Зберігаю…" : "Зберегти"}
              </button>

              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Скасувати
              </button>

              {err && <span className="text-sm text-red-500">{err}</span>}
            </div>
          </div>
        )}
      </Card>
    </>
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
            <span className="mb-1 block text-xs text-neutral-500">Назва</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Група</span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-950"
            >
              <option value="">— Без групи —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>

          {printer.kind === "bambu" && (
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-500">LAN IP (для камери)</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={bambuIp}
                  onChange={(e) => setBambuIp(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300"
                />
              </div>
            </label>
          )}

          {printer.kind !== "bambu" && (
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-500">Moonraker URL</span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://192.168.31.210"
                className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300"
              />
            </label>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {busy ? "Зберігаю…" : "Зберегти"}
          </button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">✓ Збережено</span>}
          {err && <span className="text-sm text-red-600 dark:text-red-400">{err}</span>}

          <div className="flex-1" />

          {true && (
            confirmDelete ? (
              <div className="flex items-center gap-2 rounded-lg border border-red-300 px-3 py-1.5 dark:border-red-900">
                <span className="text-sm text-red-700 dark:text-red-400">Видалити {printer.name}?</span>
                <button type="button" onClick={deletePrinter} className="rounded px-2 py-0.5 text-sm font-medium text-red-700 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950/40">Так</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">Ні</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
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

  const [printer, setPrinter] = useState<Printer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Printer>(`/api/printers/${printerId}`);
      setPrinter(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Помилка завантаження");
    } finally {
      setLoading(false);
    }
  }, [printerId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    intervalRef.current = setInterval(() => void load(), 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-neutral-500">
        Завантаження…
      </div>
    );
  }

  if (error || !printer) {
    return (
      <div className="space-y-3">
        <Link href="/printers" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          ← Назад
        </Link>
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error ?? "Принтер не знайдено"}
        </div>
      </div>
    );
  }

  const hasMoonraker = !!printer.moonraker_url;
  const isBambu = printer.kind === "bambu";

  return (
    <div className="space-y-4">
      {/* ── header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 pb-4 dark:border-neutral-800">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard"
            className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold">{printer.name}</h1>
            <div className="flex items-center gap-1.5 text-xs text-neutral-400">
              <span>{kindLabel(printer.kind)}</span>
              {printer.bambu_model && <><span>·</span><span>{printer.bambu_model}</span></>}
              {printer.group_name && <><span>·</span><span>{printer.group_name}</span></>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StateIcon state={printer.state} size={10} />
          <span className="text-sm text-neutral-600 dark:text-neutral-400">{stateLabel(printer.state)}</span>
          <button onClick={() => void load()}
            className="ml-2 rounded-lg border border-neutral-200 p-1.5 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
            title="Оновити">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button onClick={() => setSettingsOpen(true)}
            className="rounded-lg border border-neutral-200 p-1.5 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
            title="Налаштування принтера">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── main grid ── */}
      <div className="grid gap-4 lg:grid-cols-5">

        {/* left — status + filaments (3 cols) */}
        <div className="space-y-4 lg:col-span-3">
          <PrintStatusCard printer={printer} onUpdated={load} />
          <LoadedFilamentsCard printer={printer} onUpdated={load} />
          {printer.current_filament_meta && <FilamentCard printer={printer} />}

          {/* ── Collapsible control panel ── */}
          <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => setControlOpen((v) => !v)}
              className="flex w-full items-center justify-between px-5 py-3.5 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
            >
              <div className="flex items-center gap-2.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
                  <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
                </svg>
                <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500 dark:text-neutral-400">Керування</span>
              </div>
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={`text-neutral-400 transition-transform duration-200 ${controlOpen ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {controlOpen && (
              <div className="border-t border-neutral-100 dark:border-neutral-800">
                <ControlPanel printer={printer} />
              </div>
            )}
          </div>
        </div>

        {/* right — camera + temps + info (2 cols) */}
        <div className="space-y-4 lg:col-span-2">
          {(hasMoonraker || (isBambu && !!printer.bambu_dev_ip)) && <CameraCard printer={printer} />}
          <TemperaturesCard printer={printer} />

          {/* Connection info — compact */}
          {(isBambu || hasMoonraker) && (
            <Card title="Підключення">
              <div className="space-y-2 text-xs text-neutral-500 dark:text-neutral-400">
                {isBambu && printer.bambu_dev_id && (
                  <div className="flex items-center justify-between">
                    <span>Dev ID</span>
                    <span className="font-mono text-[10px]">{printer.bambu_dev_id}</span>
                  </div>
                )}
                {hasMoonraker && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[10px]">{printer.moonraker_url}</span>
                    <a href={printer.moonraker_url!} target="_blank" rel="noopener noreferrer"
                      className="shrink-0 rounded border border-neutral-200 px-2 py-0.5 text-[10px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
                      Mainsail
                    </a>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-12 backdrop-blur-sm"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4 dark:border-neutral-800">
              <div>
                <h2 className="font-semibold">{printer.name}</h2>
                <p className="text-xs text-neutral-400">Налаштування принтера</p>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div className="p-6">
              <SettingsCard
                printer={printer}
                onUpdated={() => { load(); setSettingsOpen(false); }}
                onDeleted={() => router.push("/printers")}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
