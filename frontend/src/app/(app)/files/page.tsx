"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, api, getToken } from "@/lib/api";
import { CardsSkeleton } from "@/components/ui/ContentSkeleton";
import { useUser } from "@/lib/auth-context";
import type { GcodeFile, GcodeFileMeta, GcodeFolder, Printer } from "@/lib/types";
import { usePageTitle } from "@/lib/usePageTitle";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── XHR upload ────────────────────────────────────────────────────────────────
function uploadWithProgress<T>(path: string, body: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const token = getToken();
    xhr.open("POST", `${API_URL}${path}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as T); }
        catch { reject(new ApiError(xhr.status, "Bad JSON")); }
        return;
      }
      let detail = xhr.statusText;
      try { detail = JSON.parse(xhr.responseText).detail ?? detail; } catch { /* */ }
      reject(new ApiError(xhr.status, detail));
    };
    xhr.onerror = () => reject(new ApiError(0, "Помилка мережі"));
    xhr.send(body);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60), min = m % 60;
  return m < 60 ? `${m} хв` : min > 0 ? `${h} г ${min} хв` : `${h} г`;
}
function usedSlotIndices(meta: GcodeFileMeta | null): number[] {
  if (!meta) return [];
  const total = Math.max(meta.colors?.length ?? 0, meta.types?.length ?? 0);
  if (total === 0) return [];
  const usedG = meta.used_g;
  if (!usedG || usedG.length === 0) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: total }, (_, i) => i).filter(i => (usedG[i] ?? 1) > 0);
}

// ── Folder SVG icon ───────────────────────────────────────────────────────────
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 46" fill="none" className={className} aria-hidden>
      <path d="M2 6C2 3.79 3.79 2 6 2H20L25 8H50C52.21 8 54 9.79 54 12V42C54 44.21 52.21 46 50 46H6C3.79 46 2 44.21 2 42V6Z" fill="currentColor" opacity="0.55"/>
      <path d="M2 12C2 9.79 3.79 8 6 8H50C52.21 8 54 9.79 54 12V42C54 44.21 52.21 46 50 46H6C3.79 46 2 44.21 2 42V12Z" fill="currentColor"/>
      <rect x="2" y="20" width="52" height="26" rx="4" fill="white" opacity="0.07"/>
    </svg>
  );
}

// ── Slot swatches ─────────────────────────────────────────────────────────────
function SlotSwatches({ meta }: { meta: GcodeFileMeta }) {
  const colors = meta.colors ?? [], types = meta.types ?? [];
  const indices = usedSlotIndices(meta);
  if (!indices.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {indices.map(i => (
        <span key={i} title={`Слот ${i + 1}${types[i] ? `: ${types[i]}` : ""}`}
          className="flex items-center gap-1 rounded-full border border-white/10 bg-[var(--bg-elevated)]/8 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          {colors[i] && <span className="h-2 w-2 shrink-0 rounded-full border border-white/20" style={{ background: colors[i] }} />}
          {types[i] ?? `S${i + 1}`}
        </span>
      ))}
    </div>
  );
}

// ── Slot compat ───────────────────────────────────────────────────────────────
type SlotMatch = "ok" | "type_mismatch" | "missing";
function checkSlots(meta: GcodeFileMeta | null, printer: Printer) {
  if (!meta) return [];
  return usedSlotIndices(meta).map(i => {
    const fileColor = meta.colors?.[i] ?? null, fileType = meta.types?.[i] ?? null;
    const ps = printer.loaded_filaments.find(s => s.slot === i);
    const match: SlotMatch = !ps ? "missing" : (!fileType || !ps.type || fileType.toLowerCase() === ps.type.toLowerCase()) ? "ok" : "type_mismatch";
    return { slot: i + 1, fileColor, fileType, match, printerColor: ps?.color ?? null, printerType: ps?.type ?? null };
  });
}
function compatBadge(slots: ReturnType<typeof checkSlots>) {
  if (!slots.length) return { label: "немає даних", cls: "bg-[var(--surface-2)] text-[var(--text-faint)]" };
  const missing = slots.filter(s => s.match === "missing").length;
  const mismatch = slots.filter(s => s.match === "type_mismatch").length;
  if (!missing && !mismatch) return { label: "✓ сумісний", cls: "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" };
  if (missing > 0) return { label: `${missing} слот відсутні`, cls: "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]" };
  return { label: `тип не збігається (${mismatch})`, cls: "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]" };
}

// ── Send modal ────────────────────────────────────────────────────────────────
function SendModal({ file, printers, onClose, defaultPrinterId }: {
  file: GcodeFile; printers: Printer[]; onClose: () => void; defaultPrinterId?: number;
}) {
  const [selectedId, setSelectedId] = useState<number | "">(defaultPrinterId ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());

  const sendable = printers.filter(p => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)));
  const selected = sendable.find(p => p.id === selectedId) ?? null;
  const usedSlots = useMemo(() => usedSlotIndices(file.filament_meta), [file.filament_meta]);
  const isMoonraker = !!selected?.moonraker_url;

  function selectPrinter(id: number) {
    setSelectedId(id); setResult(null);
    const m: Record<number, number> = {};
    usedSlots.forEach(i => (m[i] = i));
    setSlotMap(m);
    setCalibrateSlots(new Set(usedSlots));
  }

  async function send() {
    if (!selectedId) return;
    setBusy(true); setResult(null);
    try {
      const apiMap: Record<number, number> = {};
      usedSlots.forEach(i => (apiMap[i] = slotMap[i] ?? i));
      const body: Record<string, unknown> = { slot_map: apiMap };
      if (isMoonraker) {
        if (!autoBedLeveling) body.auto_bed_leveling = false;
        if (!timelapse) body.timelapse = false;
        if (!aiDetection) body.ai_detection = false;
        if (calibrateSlots.size !== usedSlots.length)
          body.calibrate_slots = Array.from(calibrateSlots).sort((a, b) => a - b);
      }
      const res = await api<{ ok: boolean; printer_name: string; message: string }>(
        `/api/files/${file.id}/send/${selectedId}`, { method: "POST", body: JSON.stringify(body) }
      );
      setResult({ ok: res.ok, message: res.message });
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally { setBusy(false); }
  }

  const materialRows = usedSlots.map(i => ({
    slot: i,
    color: file.filament_meta?.colors?.[i] ?? null,
    type: file.filament_meta?.types?.[i] ?? null,
    grams: file.filament_meta?.used_g?.[i] ?? null,
  }));
  const targetSlotOptions = selected?.loaded_filaments.length
    ? selected.loaded_filaments
    : Array.from({ length: 4 }, (_, slot) => ({ slot, type: null, color: null }));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-3 sm:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] w-full max-w-6xl items-center sm:min-h-[calc(100vh-48px)]">
        <div className="flex max-h-[94vh] w-full flex-col overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Відправка зі слайсера</p>
              <h2 className="mt-1 truncate text-xl font-semibold text-[var(--text-hi)]">Вибір принтера і матеріалів</h2>
              <p className="mt-1 truncate text-sm text-[var(--text-muted)]">{file.original_name}</p>
            </div>
            <button
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-xl leading-none text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
              aria-label="Закрити"
            >
              ×
            </button>
          </div>

          <div className="grid flex-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(360px,470px)]">
            <div className="space-y-4 overflow-y-auto border-b border-[var(--border)] p-4 sm:p-6 lg:border-b-0 lg:border-r">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-lg font-semibold text-[var(--text-muted)]">
                    {file.original_name.split(".").pop()?.toUpperCase() ?? "G"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--text)]">{file.original_name}</p>
                    <p className="mt-1 text-xs text-[var(--text-faint)]">
                      {fmtSize(file.size_bytes)}
                      {file.filament_meta?.estimated_minutes ? ` · ~${fmtMinutes(file.filament_meta.estimated_minutes)}` : ""}
                      {file.filament_meta?.layer_height ? ` · шар ${file.filament_meta.layer_height} мм` : ""}
                    </p>
                  </div>
                </div>
              </div>

              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--text-hi)]">Котушки з файлу</h3>
                  <span className="rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-muted)]">
                    {materialRows.length || 0} слотів
                  </span>
                </div>
                {materialRows.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {materialRows.map(m => (
                      <div key={m.slot} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
                        <div className="flex items-center gap-3">
                          <div
                            className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-black/10 shadow-inner"
                            style={{ background: m.color ?? "var(--surface-2)" }}
                          >
                            <span className="h-7 w-7 rounded-full border border-black/20 bg-[var(--surface)]/90" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">Файл слот {m.slot + 1}</p>
                            <p className="truncate text-lg font-semibold text-[var(--text-hi)]">{m.type ?? "Матеріал"}</p>
                            <p className="text-xs text-[var(--text-muted)]">{m.grams != null ? `${m.grams} г` : "витрата невідома"}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 text-sm text-[var(--text-muted)]">
                    У файлі немає даних про матеріали.
                  </div>
                )}
              </section>

              {selected && usedSlots.length > 0 && !result && (
                <section className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--text-hi)]">Ремап слотів</h3>
                  <div className="grid gap-3">
                    {materialRows.map(m => (
                      <div key={m.slot} className="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/50 p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(180px,240px)] sm:items-center">
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            className="h-11 w-11 shrink-0 rounded-full border border-black/10"
                            style={{ background: m.color ?? "var(--surface-hi)" }}
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[var(--text)]">Слот {m.slot + 1} · {m.type ?? "Матеріал"}</p>
                            <p className="text-xs text-[var(--text-faint)]">з gcode/3mf файлу</p>
                          </div>
                        </div>
                        <span className="hidden text-center text-sm text-[var(--text-muted)] sm:block">→</span>
                        <select
                          value={slotMap[m.slot] ?? m.slot}
                          onChange={e => setSlotMap(p => ({ ...p, [m.slot]: Number(e.target.value) }))}
                          className="h-10 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-accent"
                        >
                          {targetSlotOptions.map(lf => (
                            <option key={lf.slot} value={lf.slot}>
                              Принтер слот {lf.slot + 1}{lf.type ? ` · ${lf.type}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {selected && isMoonraker && !result && (
                <section className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--text-hi)]">Опції друку U1</h3>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[["autoBedLeveling", "Автокалібрування", autoBedLeveling, setAutoBedLeveling],
                      ["timelapse", "Таймлапс", timelapse, setTimelapse],
                      ["aiDetection", "AI детекція", aiDetection, setAiDetection],
                    ].map(([key, label, val, setter]) => (
                      <label key={key as string} className="flex h-11 cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 text-sm">
                        <input type="checkbox" checked={val as boolean} onChange={e => (setter as (v: boolean) => void)(e.target.checked)} className="accent-[var(--accent)]" />
                        <span className="truncate text-[var(--text-muted)]">{label as string}</span>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              {result && (
                <div className={["rounded-lg px-4 py-3 text-sm", result.ok ? "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]" : "bg-[rgba(239,68,68,.08)] text-[var(--state-error)]"].join(" ")}>
                  {result.ok ? "✓ " : "✕ "}{result.message}
                </div>
              )}
            </div>

            <aside className="flex min-h-[420px] flex-col overflow-hidden bg-[var(--bg)]">
              <div className="border-b border-[var(--border)] px-4 py-3 sm:px-5">
                <h3 className="text-sm font-semibold text-[var(--text-hi)]">Принтери</h3>
                <p className="text-xs text-[var(--text-faint)]">Обери реальний принтер перед стартом</p>
              </div>

              <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                {sendable.length === 0 ? (
                  <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-muted)]">Немає доступних принтерів</p>
                ) : (
                  <div className="grid gap-3">
                    {sendable.map(p => {
                      const slots = checkSlots(file.filament_meta, p);
                      const compat = compatBadge(slots);
                      const isSelected = selectedId === p.id;
                      return (
                        <button
                          type="button"
                          key={p.id}
                          onClick={() => selectPrinter(p.id)}
                          className={[
                            "w-full rounded-lg border p-4 text-left transition",
                            isSelected
                              ? "border-accent bg-accent/10 shadow-sm shadow-accent/10"
                              : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]/40",
                          ].join(" ")}
                        >
                          <div className="mb-3 flex items-start gap-3">
                            <span className={["mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                              isSelected ? "border-accent bg-accent text-white" : "border-[var(--border-strong)]"].join(" ")}>
                              {isSelected ? "✓" : ""}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-base font-semibold text-[var(--text-hi)]">{p.name}</p>
                              <p className="text-xs text-[var(--text-faint)]">{p.kind === "bambu" ? "Bambu Cloud" : "Moonraker / Klipper"}</p>
                            </div>
                            <span className={["shrink-0 rounded-md px-2 py-1 text-xs",
                              p.state === "printing" ? "bg-[rgba(245,158,11,.08)] text-[var(--state-warn)]"
                                : p.state === "idle" || p.state === "operational" ? "bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                                : "bg-[var(--surface-2)] text-[var(--text-faint)]"].join(" ")}>
                              {p.state ?? "—"}
                            </span>
                          </div>

                          {slots.length > 0 && (
                            <div className="grid grid-cols-2 gap-2">
                              {slots.map(s => (
                                <div key={s.slot} className={["rounded-md border px-2 py-2",
                                  s.match === "ok" ? "border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.06)]"
                                    : s.match === "type_mismatch" ? "border-[rgba(245,158,11,.25)] bg-[rgba(245,158,11,.06)]"
                                    : "border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.06)]"].join(" ")}>
                                  <div className="flex items-center gap-2">
                                    <span className="h-7 w-7 shrink-0 rounded-full border border-black/10" style={{ background: s.printerColor ?? s.fileColor ?? "var(--surface-hi)" }} />
                                    <div className="min-w-0">
                                      <p className="truncate text-xs font-medium text-[var(--text)]">Слот {s.slot}</p>
                                      <p className="truncate text-[11px] text-[var(--text-muted)]">{s.printerType ?? "порожній"}</p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="mt-3 flex justify-end">
                            <span className={`rounded-full px-2 py-1 text-xs ${compat.cls}`}>{compat.label}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>
          </div>

          <div className="flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-xs text-[var(--text-faint)]">
              {selected ? `Обрано: ${selected.name}` : "Обери принтер, щоб активувати відправку"}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="h-10 rounded-md px-4 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-hi)]">
                {result?.ok ? "Закрити" : "Скасувати"}
              </button>
              {!result?.ok && (
                <button onClick={send} disabled={!selectedId || busy}
                  className="h-10 rounded-md bg-accent px-5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40">
                  {busy ? "Надсилаю…" : "Надіслати на друк"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Folder name modal ─────────────────────────────────────────────────────────
function FolderNameModal({ title, initialValue, onConfirm, onClose }: {
  title: string; initialValue?: string;
  onConfirm: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = name.trim(); if (!t) return;
    setBusy(true); setError(null);
    try { await onConfirm(t); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Помилка"); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xs rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] shadow-2xl">
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="font-semibold text-sm text-[var(--text-hi)]">{title}</h2>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <input ref={ref} type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="Назва папки" maxLength={255}
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-hi)] placeholder-neutral-500 outline-none focus:border-accent" />
          {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-[var(--text-faint)] hover:bg-[var(--surface-hi)]">Скасувати</button>
            <button type="submit" disabled={busy || !name.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40">
              {busy ? "…" : "Зберегти"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Folder card ───────────────────────────────────────────────────────────────
function FolderCard({ folder, isDragOver, canEdit, onClick, onRename, onDelete, onDragOver, onDragLeave, onDrop }: {
  folder: GcodeFolder; isDragOver: boolean; canEdit: boolean;
  onClick: () => void; onRename: () => void; onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function close(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return (
    <div
      role="button"
      onClick={onClick}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        "group relative flex cursor-pointer select-none flex-col items-center gap-3 rounded-xl border p-4 transition-all duration-150",
        isDragOver
          ? "scale-105 border-accent bg-accent/10 shadow-lg shadow-accent/20"
          : "border-[var(--border-strong)]/60 bg-[var(--surface-2)]/50 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
      ].join(" ")}
    >
      <div className="relative">
        <FolderIcon className={["h-16 w-16 transition-transform duration-150 group-hover:scale-105", isDragOver ? "text-accent" : "text-accent"].join(" ")} />
        {folder.file_count > 0 && (
          <span className="absolute -bottom-1 -right-1 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)] leading-none min-w-[18px] text-center">
            {folder.file_count}
          </span>
        )}
      </div>

      <div className="w-full text-center">
        <p className="truncate text-sm font-medium text-[var(--text-hi)]" title={folder.name}>{folder.name}</p>
        <p className="text-xs text-[var(--text-muted)]">
          {folder.file_count} {folder.file_count === 1 ? "файл" : folder.file_count < 5 ? "файли" : "файлів"}
        </p>
      </div>

      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl">
          <span className="rounded-md bg-accent/90 px-2 py-1 text-xs font-semibold text-white shadow">
            Перемістити →
          </span>
        </div>
      )}

      {canEdit && (
        <div ref={menuRef} className="absolute right-2 top-2 z-10" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => { setMenuOpen(v => !v); setConfirmDel(false); }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] group-hover:opacity-100 text-sm"
          >⋮</button>
          {menuOpen && (
            <div className="absolute right-0 top-7 w-40 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] py-1 shadow-xl text-sm">
              <button onClick={() => { setMenuOpen(false); onRename(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
                <span>✏️</span> Перейменувати
              </button>
              {confirmDel ? (
                <button onClick={() => { setMenuOpen(false); setConfirmDel(false); onDelete(); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-[var(--state-error)] hover:bg-[rgba(239,68,68,.10)] animate-pulse">
                  <span>✕</span> Підтвердити
                </button>
              ) : (
                <button onClick={() => setConfirmDel(true)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--state-error)] hover:bg-[rgba(239,68,68,.10)]">
                  <span>🗑️</span> Видалити
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── File card ─────────────────────────────────────────────────────────────────
function FileCard({ file, canEdit, highlighted, isDragging, onSend, onDelete, onDragStart, onDragEnd }: {
  file: GcodeFile; canEdit: boolean; highlighted: boolean; isDragging: boolean;
  onSend: () => void; onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const ext = file.original_name.split(".").pop()?.toLowerCase() ?? "";

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  async function download() {
    if (dlBusy) return;
    setDlBusy(true);
    try {
      const token = getToken();
      const resp = await fetch(`${API_URL}/api/files/${file.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.original_name; a.click();
      URL.revokeObjectURL(url);
    } finally { setDlBusy(false); }
  }

  return (
    <div
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={[
        "group relative flex flex-col gap-2 rounded-xl border p-3 transition-all duration-150",
        canEdit ? "cursor-grab active:cursor-grabbing" : "",
        isDragging
          ? "scale-95 opacity-40 border-[var(--border-strong)] bg-[var(--surface-2)]"
          : highlighted
          ? "border-accent bg-accent/10 ring-2 ring-accent/20"
          : "border-[var(--border-strong)]/60 bg-[var(--surface-2)]/50 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
      ].join(" ")}
    >
      {/* thumbnail */}
      <div className="relative h-24 w-full overflow-hidden rounded-lg bg-[var(--surface)]/80 flex items-center justify-center">
        {file.has_thumbnail ? (
          <img
            src={`${API_URL}/api/files/${file.id}/thumbnail`} alt=""
            className="h-full w-full object-cover"
            onError={e => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
              const next = e.currentTarget.nextElementSibling as HTMLElement | null;
              if (next) next.style.display = "flex";
            }}
          />
        ) : null}
        <span className={["text-3xl items-center justify-center", file.has_thumbnail ? "hidden" : "flex"].join(" ")}>
          {ext === "3mf" ? "📦" : "📄"}
        </span>
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
          {fmtSize(file.size_bytes)}
        </span>
        {canEdit && !isDragging && (
          <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-[var(--text-faint)] opacity-0 group-hover:opacity-100 transition-opacity select-none">
            ⠿ drag
          </span>
        )}
      </div>

      {/* name */}
      <p className="truncate text-xs font-medium text-[var(--text)] leading-tight" title={file.original_name}>
        {file.original_name}
      </p>

      {/* filament swatches */}
      {file.filament_meta && <SlotSwatches meta={file.filament_meta} />}

      {/* time estimate */}
      {file.filament_meta?.estimated_minutes && (
        <p className="text-[10px] text-[var(--text-muted)]">~{fmtMinutes(file.filament_meta.estimated_minutes)}</p>
      )}

      {/* actions */}
      <div className="mt-auto flex gap-1.5 pt-1">
        <button onClick={onSend}
          className="flex-1 rounded-lg border border-accent/30 bg-accent/15 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/25">
          Надіслати →
        </button>
        <button onClick={download} disabled={dlBusy}
          className="rounded-lg border border-[var(--border-strong)] px-2 py-1.5 text-xs text-[var(--text-faint)] transition hover:bg-[var(--surface-2)] disabled:opacity-40"
          title="Завантажити">
          {dlBusy ? "…" : "↓"}
        </button>
        {canEdit && (
          confirmDel ? (
            <button onClick={() => { setConfirmDel(false); onDelete(); }}
              className="animate-pulse rounded-lg bg-[var(--state-error)] px-2 py-1.5 text-xs font-medium text-white">✕</button>
          ) : (
            <button onClick={() => setConfirmDel(true)}
              className="rounded-lg border border-[var(--border-strong)] px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:border-[rgba(239,68,68,.3)] hover:bg-[rgba(239,68,68,.10)] hover:text-[var(--state-error)]">✕</button>
          )
        )}
      </div>
    </div>
  );
}

// ── Root drop zone (move file back to root) ────────────────────────────────────
function RootDropZone({ isDragOver, onDragOver, onDragLeave, onDrop }: {
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        "flex items-center justify-center gap-2 rounded-xl border-2 border-dashed py-3 px-4 text-sm transition-all duration-150",
        isDragOver
          ? "border-[var(--accent)] bg-[rgba(56,189,248,.08)] text-[var(--accent)] scale-[1.02]"
          : "border-[var(--border-strong)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-muted)]",
      ].join(" ")}
    >
      <span>🏠</span>
      <span>{isDragOver ? "Відпусти, щоб прибрати з папки" : "Перетягни сюди, щоб прибрати з папки"}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function FilesPage() {
  usePageTitle("nav.files");
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator" || user.role === "manager";
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight") ? Number(searchParams.get("highlight")) : null;
  const defaultPrinterId = searchParams.get("printer") ? Number(searchParams.get("printer")) : null;
  const slicerLatest = searchParams.get("slicer") === "latest";

  const [files, setFiles] = useState<GcodeFile[]>([]);
  const [folders, setFolders] = useState<GcodeFolder[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendFile, setSendFile] = useState<GcodeFile | null>(null);
  const [search, setSearch] = useState("");

  // Navigation: null = root, number = inside folder
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);

  // Drag state
  const [draggedFile, setDraggedFile] = useState<GcodeFile | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<number | "root" | null>(null);

  // Modals
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<GcodeFolder | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoOpenAttemptsRef = useRef(0);
  const autoOpenKeyRef = useRef("");

  // ── Load ──
  const load = useCallback(async () => {
    try {
      const [f, p, fols] = await Promise.all([
        api<GcodeFile[]>("/api/files"),
        api<Printer[]>("/api/printers"),
        api<GcodeFolder[]>("/api/folders"),
      ]);
      setFiles(f); setPrinters(p); setFolders(fols);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-open send modal from slicer redirects. The upload can be visible to
  // the UI a moment after Orca opens Device tab, so retry briefly instead of
  // requiring a manual page refresh.
  useEffect(() => {
    const key = highlightId ? `highlight:${highlightId}` : slicerLatest ? "latest" : "";
    if (autoOpenKeyRef.current !== key) {
      autoOpenKeyRef.current = key;
      autoOpenAttemptsRef.current = 0;
    }
    if (!key || loading || sendFile) return;

    const target = highlightId
      ? files.find(f => f.id === highlightId) ?? null
      : [...files].sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime())[0] ?? null;

    if (target) {
      setCurrentFolderId(target.folder_id ?? null);
      setSendFile(target);
      return;
    }

    if (autoOpenAttemptsRef.current >= 15) return;
    autoOpenAttemptsRef.current += 1;
    const t = window.setTimeout(() => { void load(); }, 1000);
    return () => window.clearTimeout(t);
  }, [highlightId, slicerLatest, loading, files, sendFile, load]);

  // ── Upload ──
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    setUploading(true); setUploadProgress(0); setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const path = currentFolderId ? `/api/files/upload?folder_id=${currentFolderId}` : "/api/files/upload";
      const saved = await uploadWithProgress<GcodeFile>(path, form, pct => setUploadProgress(pct));
      setFiles(prev => [saved, ...prev]);
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
      setSendFile(saved);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Помилка завантаження");
    } finally { setUploading(false); setUploadProgress(0); }
  }

  // ── Delete ──
  async function handleDelete(file: GcodeFile) {
    try {
      await api(`/api/files/${file.id}`, { method: "DELETE" });
      setFiles(prev => prev.filter(f => f.id !== file.id));
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
    } catch (e) { setUploadError(e instanceof ApiError ? e.message : "Помилка видалення"); }
  }

  // ── Move ──
  async function handleMove(file: GcodeFile, folderId: number | null) {
    if (file.folder_id === folderId) return;
    try {
      const updated = await api<GcodeFile>(`/api/files/${file.id}/move`, {
        method: "PATCH", body: JSON.stringify({ folder_id: folderId }),
      });
      setFiles(prev => prev.map(f => f.id === updated.id ? updated : f));
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
    } catch (e) { setUploadError(e instanceof ApiError ? e.message : "Помилка переміщення"); }
  }

  // ── Folder CRUD ──
  async function handleCreateFolder(name: string) {
    const folder = await api<GcodeFolder>("/api/folders", { method: "POST", body: JSON.stringify({ name }) });
    setFolders(prev => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)));
    setShowNewFolder(false);
    setCurrentFolderId(folder.id);
  }

  async function handleRenameFolder(folder: GcodeFolder, name: string) {
    const updated = await api<GcodeFolder>(`/api/folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    setFolders(prev => prev.map(f => f.id === updated.id ? updated : f).sort((a, b) => a.name.localeCompare(b.name)));
    setRenamingFolder(null);
  }

  async function handleDeleteFolder(folder: GcodeFolder) {
    try {
      await api(`/api/folders/${folder.id}`, { method: "DELETE" });
      setFolders(prev => prev.filter(f => f.id !== folder.id));
      setFiles(prev => prev.map(f => f.folder_id === folder.id ? { ...f, folder_id: null } : f));
      if (currentFolderId === folder.id) setCurrentFolderId(null);
    } catch (e) { setUploadError(e instanceof ApiError ? e.message : "Помилка видалення папки"); }
  }

  // ── Drag handlers ──
  function onFileDragStart(e: React.DragEvent, file: GcodeFile) {
    e.dataTransfer.setData("fileId", file.id.toString());
    e.dataTransfer.effectAllowed = "move";
    setDraggedFile(file);
  }

  function onFolderDragOver(e: React.DragEvent, target: number | "root") {
    if (!draggedFile) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(target);
  }

  function onFolderDragLeave() {
    setDragOverTarget(null);
  }

  function onFolderDrop(e: React.DragEvent, folderId: number | null) {
    e.preventDefault();
    setDragOverTarget(null);
    const fileId = Number(e.dataTransfer.getData("fileId"));
    if (!fileId) return;
    const file = files.find(f => f.id === fileId);
    if (file) handleMove(file, folderId);
    setDraggedFile(null);
  }

  // ── Computed ──
  const currentFolder = currentFolderId ? folders.find(f => f.id === currentFolderId) ?? null : null;

  // At root: show files without a folder. Inside folder: show files in that folder.
  const visibleFiles = (currentFolderId === null
    ? files.filter(f => f.folder_id === null)
    : files.filter(f => f.folder_id === currentFolderId)
  ).filter(f => f.original_name.toLowerCase().includes(search.toLowerCase()));

  const targetPrinter = defaultPrinterId ? printers.find(p => p.id === defaultPrinterId) : null;

  if (loading) return <CardsSkeleton count={12} cols={5} />;

  const isDragging = !!draggedFile;

  return (
    <div className="min-h-screen">
      {/* printer banner */}
      {targetPrinter && !sendFile && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[rgba(56,189,248,.3)] bg-[rgba(56,189,248,.08)] px-4 py-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-[var(--accent)]">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <p className="text-sm text-[var(--accent)]">
            Вибери файл для відправки на <strong className="text-[var(--text)]">{targetPrinter.name}</strong>
          </p>
        </div>
      )}

      {/* ── Header ── */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {/* breadcrumb */}
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {currentFolder ? (
            <>
              <button onClick={() => setCurrentFolderId(null)}
                className="flex items-center gap-1.5 text-sm text-[var(--text-faint)] hover:text-[var(--text)] transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 5l-7 7 7 7"/>
                </svg>
                Файли
              </button>
              <span className="text-[var(--text-muted)]">/</span>
              <span className="text-sm font-semibold text-[var(--text-hi)]">{currentFolder.name}</span>
              <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]">
                {currentFolder.file_count}
              </span>
            </>
          ) : (
            <div>
              <h1 className="text-lg font-bold text-[var(--text-hi)]">Файли</h1>
              <p className="text-xs text-[var(--text-muted)]">
                {files.length} файлів · {folders.length} папок
              </p>
            </div>
          )}
        </div>

        {/* search */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] text-sm">🔍</span>
          <input
            type="text" placeholder="Пошук…" value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-48 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)]/60 py-2 pl-8 pr-3 text-sm text-[var(--text)] placeholder-neutral-500 outline-none focus:border-accent transition"
          />
        </div>

        {/* actions */}
        {canEdit && (
          <div className="flex items-center gap-2">
            {uploadError && <span className="text-xs text-[var(--state-error)]">{uploadError}</span>}
            {!currentFolder && (
              <button onClick={() => setShowNewFolder(true)}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)]/60 px-3 py-2 text-sm text-[var(--text-muted)] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]">
                <FolderIcon className="h-4 w-4 text-accent" />
                Нова папка
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="relative flex min-w-40 items-center justify-center gap-2 overflow-hidden rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:cursor-default disabled:opacity-70"
            >
              {uploading && (
                <span className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--bg-elevated)]/20 transition-[width] duration-150" style={{ width: `${uploadProgress}%` }} />
              )}
              <span className="relative flex items-center gap-2">
                {uploading
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  : <span>↑</span>}
                {uploading ? `${uploadProgress}%` : "Завантажити"}
              </span>
            </button>
            <input ref={fileInputRef} type="file" accept=".gcode,.gco,.g,.3mf,.bgcode" className="hidden" onChange={handleUpload} />
          </div>
        )}
      </div>

      {/* ── Root drop zone (visible only while dragging inside a folder) ── */}
      {isDragging && currentFolderId !== null && (
        <div className="mb-4">
          <RootDropZone
            isDragOver={dragOverTarget === "root"}
            onDragOver={e => onFolderDragOver(e, "root")}
            onDragLeave={onFolderDragLeave}
            onDrop={e => onFolderDrop(e, null)}
          />
        </div>
      )}

      {/* ── Folders grid (root only) ── */}
      {currentFolderId === null && folders.length > 0 && (
        <div className="mb-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Папки · {folders.length}
          </p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {folders.map(folder => (
              <FolderCard
                key={folder.id}
                folder={folder}
                isDragOver={dragOverTarget === folder.id}
                canEdit={canEdit}
                onClick={() => setCurrentFolderId(folder.id)}
                onRename={() => setRenamingFolder(folder)}
                onDelete={() => handleDeleteFolder(folder)}
                onDragOver={e => onFolderDragOver(e, folder.id)}
                onDragLeave={onFolderDragLeave}
                onDrop={e => onFolderDrop(e, folder.id)}
              />
            ))}

            {/* Drag-to-root zone at root level (only visible while dragging a file that's in a folder) */}
            {isDragging && draggedFile?.folder_id !== null && (
              <div
                onDragOver={e => onFolderDragOver(e, "root")}
                onDragEnter={e => onFolderDragOver(e, "root")}
                onDragLeave={onFolderDragLeave}
                onDrop={e => onFolderDrop(e, null)}
                className={[
                  "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 transition-all duration-150 cursor-default",
                  dragOverTarget === "root"
                    ? "border-[var(--accent)] bg-[rgba(56,189,248,.08)] scale-105"
                    : "border-[var(--border-strong)] opacity-60",
                ].join(" ")}
              >
                <span className="text-2xl">🏠</span>
                <span className="text-center text-xs text-[var(--text-muted)] leading-tight">Без папки</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Compact folder strip inside folder view (for drag targets) ── */}
      {currentFolderId !== null && isDragging && folders.length > 1 && (
        <div className="mb-4">
          <p className="mb-2 text-xs text-[var(--text-muted)]">Перетягни до іншої папки:</p>
          <div className="flex flex-wrap gap-2">
            {folders.filter(f => f.id !== currentFolderId).map(folder => (
              <div
                key={folder.id}
                onDragOver={e => onFolderDragOver(e, folder.id)}
                onDragEnter={e => onFolderDragOver(e, folder.id)}
                onDragLeave={onFolderDragLeave}
                onDrop={e => onFolderDrop(e, folder.id)}
                className={[
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all duration-150 cursor-default select-none",
                  dragOverTarget === folder.id
                    ? "scale-105 border-accent bg-accent/10 text-accent"
                    : "border-[var(--border-strong)] text-[var(--text-faint)] hover:border-[var(--border-strong)]",
                ].join(" ")}
              >
                <FolderIcon className="h-4 w-4 text-accent" />
                <span className="truncate max-w-[120px]">{folder.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Files grid ── */}
      {currentFolderId === null && (
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {files.filter(f => f.folder_id === null).length > 0 ? `Файли без папки · ${files.filter(f => f.folder_id === null).length}` : ""}
        </p>
      )}

      {visibleFiles.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-[var(--text-muted)]">
          <span className="text-5xl">{currentFolderId ? "📁" : "🗂️"}</span>
          <p className="text-sm">
            {search ? "Нічого не знайдено" : currentFolderId ? "Папка порожня — перетягни сюди файли" : "Завантажте першу нарізку"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {visibleFiles.map(f => (
            <FileCard
              key={f.id}
              file={f}
              canEdit={canEdit}
              highlighted={f.id === highlightId}
              isDragging={draggedFile?.id === f.id}
              onSend={() => setSendFile(f)}
              onDelete={() => handleDelete(f)}
              onDragStart={e => onFileDragStart(e, f)}
              onDragEnd={() => { setDraggedFile(null); setDragOverTarget(null); }}
            />
          ))}
        </div>
      )}

      {/* Empty folder drop zone for dragging into empty folders */}
      {currentFolderId !== null && visibleFiles.length === 0 && isDragging && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOverTarget(currentFolderId); }}
          onDragLeave={() => setDragOverTarget(null)}
          onDrop={e => onFolderDrop(e, currentFolderId)}
          className={[
            "mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-16 transition-all",
            dragOverTarget === currentFolderId
              ? "border-accent bg-accent/10 text-accent"
              : "border-[var(--border-strong)] text-[var(--text-muted)]",
          ].join(" ")}
        >
          <span className="text-4xl">📁</span>
          <span className="text-sm">{dragOverTarget === currentFolderId ? "Відпусти!" : "Перетягни файли сюди"}</span>
        </div>
      )}

      {/* send modal */}
      {sendFile && (
        <SendModal file={sendFile} printers={printers} onClose={() => setSendFile(null)} defaultPrinterId={defaultPrinterId ?? undefined} />
      )}

      {/* create folder modal */}
      {showNewFolder && (
        <FolderNameModal title="Нова папка" onConfirm={handleCreateFolder} onClose={() => setShowNewFolder(false)} />
      )}

      {/* rename folder modal */}
      {renamingFolder && (
        <FolderNameModal
          title="Перейменувати папку"
          initialValue={renamingFolder.name}
          onConfirm={name => handleRenameFolder(renamingFolder, name)}
          onClose={() => setRenamingFolder(null)}
        />
      )}
    </div>
  );
}
