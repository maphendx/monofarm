"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import {
  flagLabel,
  kindLabel,
  printerTone,
  stateEmoji,
  stateLabel,
} from "@/lib/printerLabels";
import type { Filament, FilamentColor, FilamentSlot, Printer, PrinterGroup } from "@/lib/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatEta(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min} хв`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

const TONE_BG: Record<string, string> = {
  printing: "bg-blue-500/10 border-blue-500/40 text-blue-700 dark:text-blue-300",
  ok: "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300",
  idle: "bg-neutral-100 border-neutral-300 text-neutral-600 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-400",
  muted: "bg-neutral-100 border-neutral-300 text-neutral-400 dark:bg-neutral-800 dark:border-neutral-700",
};

function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold text-neutral-500 uppercase tracking-wide dark:text-neutral-400">{title}</h2>}
      {children}
    </div>
  );
}

// ── webcam ────────────────────────────────────────────────────────────────────

function WebcamCard({ printerId }: { printerId: number }) {
  const [tick, setTick] = useState(0);
  const [hasWebcam, setHasWebcam] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  if (!hasWebcam) return null;

  return (
    <Card title="Вебкамера">
      <div className="overflow-hidden rounded-lg bg-neutral-950">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/printers/${printerId}/webcam/snapshot?t=${tick}`}
          alt="Webcam"
          className="w-full object-cover"
          onError={() => setHasWebcam(false)}
        />
      </div>
    </Card>
  );
}

// ── temperatures ──────────────────────────────────────────────────────────────

function TempBar({ current, target }: { current: number; target: number | null }) {
  const max = target ? Math.max(target, current, 10) : Math.max(current, 10);
  const pct = Math.min(100, (current / max) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
      <div className="h-full rounded-full bg-orange-500 transition-[width] duration-700" style={{ width: `${pct}%` }} />
    </div>
  );
}

function TemperaturesCard({ printer }: { printer: Printer }) {
  const rows = [
    {
      label: "Сопло",
      icon: "🌡",
      current: printer.extruder_temp,
      target: printer.extruder_target,
    },
    {
      label: "Стіл",
      icon: "▣",
      current: printer.bed_temp,
      target: printer.bed_target,
    },
  ].filter((r) => r.current != null);

  if (rows.length === 0) return null;

  return (
    <Card title="Температури">
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
                {r.icon} {r.label}
              </span>
              <span className="font-mono font-medium">
                {Math.round(r.current!)}°
                {r.target != null && r.target > 0 && (
                  <span className="ml-1 text-xs text-neutral-400">→ {Math.round(r.target)}°</span>
                )}
              </span>
            </div>
            <TempBar current={r.current!} target={r.target ?? null} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── print status + controls ───────────────────────────────────────────────────

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

  const tone = printerTone(printer);
  const isPrinting = printer.state === "printing";
  const isPaused = printer.state === "paused";
  const needsBedClear = printer.state === "awaiting_bed_clear";
  const isSimplyPrint = printer.kind === "simplyprint";
  const isBambu = printer.kind === "bambu";
  const hasMoonraker = !!printer.moonraker_url;
  const hasLiveSource = hasMoonraker || isSimplyPrint || isBambu;
  const eta = formatEta(printer.eta_minutes);

  async function act(action: string) {
    if (busy) return;
    if (action === "cancel" && !confirm("Скасувати поточний друк?")) return;
    setBusy(action);
    setErr(null);
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
    <Card>
      {/* state badge */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{stateEmoji(printer.state)}</span>
          <div>
            <div className="font-semibold">{stateLabel(printer.state)}</div>
            <div className="text-xs text-neutral-500">{kindLabel(printer.kind)}</div>
          </div>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_BG[tone]}`}>
          {stateLabel(printer.state)}
        </span>
      </div>

      {/* flags */}
      {printer.flags?.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {printer.flags.map((f) => (
            <span key={f} className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      {/* job + progress */}
      {(printer.job || isPrinting || isPaused) && (
        <div className="mb-4 space-y-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          {printer.job && (
            <div className="truncate text-sm font-medium">📦 {printer.job}</div>
          )}
          {eta && <div className="text-xs text-neutral-500">⏱ Залишилось: {eta}</div>}
          {printer.progress_pct != null && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-neutral-500">
                <span>Прогрес</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">{printer.progress_pct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                <div
                  className="h-full rounded-full bg-blue-500 transition-[width] duration-1000 ease-linear"
                  style={{ width: `${printer.progress_pct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* action buttons */}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {isPrinting && (
            <button
              onClick={() => act("pause")}
              disabled={busy !== null}
              className="rounded-lg bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-500/30 disabled:opacity-40 dark:text-amber-300"
            >
              {busy === "pause" ? "…" : "⏸ Пауза"}
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => act("resume")}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/30 disabled:opacity-40 dark:text-emerald-300"
            >
              {busy === "resume" ? "…" : "▶ Продовжити"}
            </button>
          )}
          {(isPrinting || isPaused) && (
            <button
              onClick={() => act("cancel")}
              disabled={busy !== null}
              className="rounded-lg bg-red-500/15 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-500/30 disabled:opacity-40 dark:text-red-300"
            >
              {busy === "cancel" ? "…" : "✕ Зупинити"}
            </button>
          )}
          {needsBedClear && isSimplyPrint && (
            <button
              onClick={() => act("clear-bed")}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/30 disabled:opacity-40 dark:text-emerald-300"
            >
              {busy === "clear-bed" ? "…" : "✓ Стіл очищено"}
            </button>
          )}
          {isPrinting && hasMoonraker && (
            <button
              onClick={() => act("skip-object")}
              disabled={busy !== null}
              title="Потребує [exclude_object] в printer.cfg"
              className="rounded-lg bg-neutral-500/10 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-500/20 disabled:opacity-40 dark:text-neutral-300"
            >
              {busy === "skip-object" ? "…" : "⏭ Пропустити об'єкт"}
            </button>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
    </Card>
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
          <span>⏱ {formatEta(meta.estimated_minutes)}</span>
        )}
        {meta.total_layers != null && (
          <span>▣ {meta.total_layers} шарів</span>
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
      { slot: prev.length, color: "#888888", color_name: null, type: "PLA", brand: null, filament_id: null },
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
        {/* ── spool display ── */}
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
  const [groupId, setGroupId] = useState<string>(printer.group_id?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      if (name !== printer.name || url !== (printer.moonraker_url ?? "")) {
        await api(`/api/printers/${printer.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim() || undefined,
            moonraker_url: url.trim() || undefined,
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
    if (!confirm(`Видалити ${printer.name}? Всі записи плану з ним теж видаляться.`)) return;
    try {
      await api(`/api/printers/${printer.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Помилка видалення");
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

          {printer.kind !== "simplyprint" && (
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

          {printer.kind !== "simplyprint" && (
            <button
              type="button"
              onClick={deletePrinter}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              🗑 Видалити принтер
            </button>
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
        <Link href="/dashboard" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          ← Назад
        </Link>
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error ?? "Принтер не знайдено"}
        </div>
      </div>
    );
  }

  const tone = printerTone(printer);
  const hasMoonraker = !!printer.moonraker_url;
  const isBambu = printer.kind === "bambu";

  return (
    <div className="space-y-5">
      {/* breadcrumb + header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/dashboard"
            className="mb-1 inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ← Дашборд
          </Link>
          <h1 className="text-2xl font-bold">{printer.name}</h1>
          <div className="mt-0.5 flex items-center gap-2 text-sm text-neutral-500">
            <span>{kindLabel(printer.kind)}</span>
            {printer.bambu_model && <span>· {printer.bambu_model}</span>}
            {printer.group_name && (
              <>
                <span>·</span>
                <span>📁 {printer.group_name}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-3 py-1 text-sm font-medium ${TONE_BG[tone]}`}>
            {stateEmoji(printer.state)} {stateLabel(printer.state)}
          </span>
          <button
            onClick={() => void load()}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
          >
            ↻ Оновити
          </button>
        </div>
      </div>

      {/* main grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* left — 2 cols */}
        <div className="space-y-4 lg:col-span-2">
          <PrintStatusCard printer={printer} onUpdated={load} />
          <LoadedFilamentsCard printer={printer} onUpdated={load} />
          <FilamentCard printer={printer} />
        </div>

        {/* right — 1 col */}
        <div className="space-y-4">
          {hasMoonraker && <WebcamCard printerId={printer.id} />}
          <TemperaturesCard printer={printer} />

          {/* SP info */}
          {printer.kind === "simplyprint" && printer.sp_printer_id && (
            <Card title="SimplyPrint">
              <div className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
                <div>ID: <span className="font-mono">{printer.sp_printer_id}</span></div>
                <a
                  href="https://app.simplyprint.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-300 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/30"
                >
                  🔗 Відкрити в SimplyPrint
                </a>
              </div>
            </Card>
          )}

          {/* Bambu info */}
          {isBambu && printer.bambu_dev_id && (
            <Card title="Bambu Lab">
              <div className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
                <div>Dev ID: <span className="font-mono">{printer.bambu_dev_id}</span></div>
                {printer.bambu_model && <div>Модель: {printer.bambu_model}</div>}
              </div>
            </Card>
          )}

          {/* Moonraker link */}
          {hasMoonraker && (
            <Card title="Moonraker">
              <div className="space-y-2 text-sm">
                <div className="truncate font-mono text-xs text-neutral-500">{printer.moonraker_url}</div>
                <a
                  href={printer.moonraker_url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-300 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/30"
                >
                  🔗 Відкрити в Mainsail
                </a>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* settings — admin only, full width */}
      <SettingsCard
        printer={printer}
        onUpdated={load}
        onDeleted={() => router.push("/dashboard")}
      />
    </div>
  );
}
