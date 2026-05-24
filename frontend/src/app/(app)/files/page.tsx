"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { GcodeFile, GcodeFileMeta, GcodeFolder, Printer } from "@/lib/types";

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
          className="flex items-center gap-1 rounded-full border border-white/10 bg-white/8 px-1.5 py-0.5 text-[10px] text-neutral-300">
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
  if (!slots.length) return { label: "немає даних", cls: "bg-neutral-700 text-neutral-400" };
  const missing = slots.filter(s => s.match === "missing").length;
  const mismatch = slots.filter(s => s.match === "type_mismatch").length;
  if (!missing && !mismatch) return { label: "✓ сумісний", cls: "bg-emerald-500/20 text-emerald-400" };
  if (missing > 0) return { label: `${missing} слот відсутні`, cls: "bg-red-500/20 text-red-400" };
  return { label: `тип не збігається (${mismatch})`, cls: "bg-amber-500/20 text-amber-400" };
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-5 py-4">
          <h2 className="font-semibold text-neutral-100">Надіслати на принтер</h2>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{file.original_name}</p>
        </div>

        {file.filament_meta && (
          <div className="border-b border-neutral-800 px-5 pb-4 pt-3">
            <p className="mb-1.5 text-xs font-medium text-neutral-500">Потрібні матеріали</p>
            <SlotSwatches meta={file.filament_meta} />
            {file.filament_meta.estimated_minutes && (
              <p className="mt-1.5 text-xs text-neutral-500">
                ~{fmtMinutes(file.filament_meta.estimated_minutes)}
                {file.filament_meta.layer_height && ` · шар ${file.filament_meta.layer_height} мм`}
              </p>
            )}
          </div>
        )}

        <div className="space-y-3 px-5 py-4">
          {sendable.length === 0 ? (
            <p className="text-sm text-neutral-500">Немає доступних принтерів</p>
          ) : (
            <div className="grid gap-2 max-h-64 overflow-y-auto pr-1">
              {sendable.map(p => {
                const slots = checkSlots(file.filament_meta, p);
                const compat = compatBadge(slots);
                return (
                  <label key={p.id} className={["flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition",
                    selectedId === p.id ? "border-accent bg-accent/10" : "border-neutral-700 hover:border-neutral-600 hover:bg-neutral-800/50"].join(" ")}>
                    <div className="flex items-center gap-3">
                      <input type="radio" name="printer" value={p.id} checked={selectedId === p.id} onChange={() => selectPrinter(p.id)} className="accent-[var(--accent)]" />
                      <span className="flex-1 truncate text-sm font-medium text-neutral-200">{p.name}</span>
                      <span className={["shrink-0 rounded px-1.5 py-0.5 text-xs",
                        p.state === "printing" ? "bg-amber-500/20 text-amber-400"
                          : p.state === "idle" || p.state === "operational" ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-neutral-700 text-neutral-400"].join(" ")}>
                        {p.state ?? "—"}
                      </span>
                    </div>
                    {slots.length > 0 && (
                      <div className="ml-6 flex flex-wrap gap-1">
                        {slots.map(s => (
                          <span key={s.slot} className={["flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                            s.match === "ok" ? "bg-emerald-500/15 text-emerald-400"
                              : s.match === "type_mismatch" ? "bg-amber-500/15 text-amber-400"
                              : "bg-red-500/15 text-red-400"].join(" ")}>
                            {s.fileColor && <span className="h-2 w-2 rounded-full" style={{ background: s.fileColor }} />}
                            {s.match === "ok" ? "✓" : s.match === "type_mismatch" ? "~" : "✕"} S{s.slot}
                          </span>
                        ))}
                        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${compat.cls}`}>{compat.label}</span>
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {selected && usedSlots.length > 0 && !result && (
            <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
              <p className="mb-2 text-xs font-medium text-neutral-400">Ремаппінг слотів</p>
              <div className="space-y-2">
                {usedSlots.map(i => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="flex flex-1 items-center gap-1.5">
                      {file.filament_meta?.colors?.[i] && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: file.filament_meta.colors[i] }} />}
                      <span className="truncate text-neutral-300">Слот {i + 1}{file.filament_meta?.types?.[i] ? ` · ${file.filament_meta.types[i]}` : ""}</span>
                    </div>
                    <span className="text-neutral-500">→</span>
                    <select value={slotMap[i] ?? i} onChange={e => setSlotMap(p => ({ ...p, [i]: Number(e.target.value) }))}
                      className="rounded border border-neutral-600 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-200 outline-none focus:border-accent">
                      {selected.loaded_filaments.length > 0
                        ? selected.loaded_filaments.map(lf => <option key={lf.slot} value={lf.slot}>Слот {lf.slot + 1}{lf.type ? ` · ${lf.type}` : ""}</option>)
                        : Array.from({ length: 4 }).map((_, s) => <option key={s} value={s}>Слот {s + 1}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selected && isMoonraker && !result && (
            <div className="rounded-lg border border-neutral-700 bg-neutral-800/60 p-3">
              <p className="mb-2 text-xs font-medium text-neutral-400">Опції друку</p>
              {[["autoBedLeveling", "Автокалібрування столу", autoBedLeveling, setAutoBedLeveling],
                ["timelapse", "Таймлапс", timelapse, setTimelapse],
                ["aiDetection", "AI детекція", aiDetection, setAiDetection],
              ].map(([key, label, val, setter]) => (
                <label key={key as string} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                  <input type="checkbox" checked={val as boolean} onChange={e => (setter as (v: boolean) => void)(e.target.checked)} className="accent-[var(--accent)]" />
                  <span className="text-neutral-300">{label as string}</span>
                </label>
              ))}
            </div>
          )}

          {result && (
            <div className={["rounded-lg px-3 py-2 text-sm", result.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"].join(" ")}>
              {result.ok ? "✓ " : "✕ "}{result.message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 px-5 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800">
            {result?.ok ? "Закрити" : "Скасувати"}
          </button>
          {!result?.ok && (
            <button onClick={send} disabled={!selectedId || busy}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 disabled:opacity-40">
              {busy ? "Надсилаю…" : "Надіслати"}
            </button>
          )}
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
      <div className="w-full max-w-xs rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-5 py-4">
          <h2 className="font-semibold text-sm text-neutral-100">{title}</h2>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <input ref={ref} type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="Назва папки" maxLength={255}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-accent" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800">Скасувати</button>
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
          : "border-neutral-700/60 bg-neutral-800/50 hover:border-neutral-600 hover:bg-neutral-800",
      ].join(" ")}
    >
      <div className="relative">
        <FolderIcon className={["h-16 w-16 transition-transform duration-150 group-hover:scale-105", isDragOver ? "text-accent" : "text-accent"].join(" ")} />
        {folder.file_count > 0 && (
          <span className="absolute -bottom-1 -right-1 rounded-full bg-neutral-700 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-300 leading-none min-w-[18px] text-center">
            {folder.file_count}
          </span>
        )}
      </div>

      <div className="w-full text-center">
        <p className="truncate text-sm font-medium text-neutral-100" title={folder.name}>{folder.name}</p>
        <p className="text-xs text-neutral-500">
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 opacity-0 transition hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100 text-sm"
          >⋮</button>
          {menuOpen && (
            <div className="absolute right-0 top-7 w-40 rounded-lg border border-neutral-700 bg-neutral-800 py-1 shadow-xl text-sm">
              <button onClick={() => { setMenuOpen(false); onRename(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-300 hover:bg-neutral-700">
                <span>✏️</span> Перейменувати
              </button>
              {confirmDel ? (
                <button onClick={() => { setMenuOpen(false); setConfirmDel(false); onDelete(); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-red-400 hover:bg-red-900/30 animate-pulse">
                  <span>✕</span> Підтвердити
                </button>
              ) : (
                <button onClick={() => setConfirmDel(true)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-red-900/30">
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
          ? "scale-95 opacity-40 border-neutral-600 bg-neutral-800"
          : highlighted
          ? "border-accent bg-accent/10 ring-2 ring-accent/20"
          : "border-neutral-700/60 bg-neutral-800/50 hover:border-neutral-600 hover:bg-neutral-800",
      ].join(" ")}
    >
      {/* thumbnail */}
      <div className="relative h-24 w-full overflow-hidden rounded-lg bg-neutral-900/80 flex items-center justify-center">
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
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">
          {fmtSize(file.size_bytes)}
        </span>
        {canEdit && !isDragging && (
          <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity select-none">
            ⠿ drag
          </span>
        )}
      </div>

      {/* name */}
      <p className="truncate text-xs font-medium text-neutral-200 leading-tight" title={file.original_name}>
        {file.original_name}
      </p>

      {/* filament swatches */}
      {file.filament_meta && <SlotSwatches meta={file.filament_meta} />}

      {/* time estimate */}
      {file.filament_meta?.estimated_minutes && (
        <p className="text-[10px] text-neutral-500">~{fmtMinutes(file.filament_meta.estimated_minutes)}</p>
      )}

      {/* actions */}
      <div className="mt-auto flex gap-1.5 pt-1">
        <button onClick={onSend}
          className="flex-1 rounded-lg border border-accent/30 bg-accent/15 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/25">
          Надіслати →
        </button>
        <button onClick={download} disabled={dlBusy}
          className="rounded-lg border border-neutral-700 px-2 py-1.5 text-xs text-neutral-400 transition hover:bg-neutral-700 disabled:opacity-40"
          title="Завантажити">
          {dlBusy ? "…" : "↓"}
        </button>
        {canEdit && (
          confirmDel ? (
            <button onClick={() => { setConfirmDel(false); onDelete(); }}
              className="animate-pulse rounded-lg bg-red-600 px-2 py-1.5 text-xs font-medium text-white">✕</button>
          ) : (
            <button onClick={() => setConfirmDel(true)}
              className="rounded-lg border border-neutral-700 px-2 py-1.5 text-xs text-neutral-500 transition hover:border-red-500/40 hover:bg-red-900/20 hover:text-red-400">✕</button>
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
          ? "border-orange-400 bg-orange-400/10 text-orange-400 scale-[1.02]"
          : "border-neutral-700 text-neutral-600 hover:border-neutral-600 hover:text-neutral-500",
      ].join(" ")}
    >
      <span>🏠</span>
      <span>{isDragOver ? "Відпусти, щоб прибрати з папки" : "Перетягни сюди, щоб прибрати з папки"}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function FilesPage() {
  const user = useUser();
  const canEdit = user.role === "admin" || user.role === "operator" || user.role === "manager";
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight") ? Number(searchParams.get("highlight")) : null;
  const defaultPrinterId = searchParams.get("printer") ? Number(searchParams.get("printer")) : null;

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

  // Auto-open send modal from ?highlight=
  useEffect(() => {
    if (!highlightId || loading || sendFile) return;
    const f = files.find(f => f.id === highlightId);
    if (f) setSendFile(f);
  }, [highlightId, loading, files]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (loading) return (
    <div className="flex items-center justify-center py-24 text-sm text-neutral-500">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-accent mr-2" />
      Завантаження…
    </div>
  );

  const isDragging = !!draggedFile;

  return (
    <div className="min-h-screen">
      {/* printer banner */}
      {targetPrinter && !sendFile && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-blue-400">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <p className="text-sm text-blue-300">
            Вибери файл для відправки на <strong className="text-blue-200">{targetPrinter.name}</strong>
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
                className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-200 transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 5l-7 7 7 7"/>
                </svg>
                Файли
              </button>
              <span className="text-neutral-600">/</span>
              <span className="text-sm font-semibold text-neutral-100">{currentFolder.name}</span>
              <span className="rounded-full bg-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {currentFolder.file_count}
              </span>
            </>
          ) : (
            <div>
              <h1 className="text-lg font-bold text-neutral-100">Файли</h1>
              <p className="text-xs text-neutral-500">
                {files.length} файлів · {folders.length} папок
              </p>
            </div>
          )}
        </div>

        {/* search */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">🔍</span>
          <input
            type="text" placeholder="Пошук…" value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-48 rounded-lg border border-neutral-700 bg-neutral-800/60 py-2 pl-8 pr-3 text-sm text-neutral-200 placeholder-neutral-500 outline-none focus:border-accent transition"
          />
        </div>

        {/* actions */}
        {canEdit && (
          <div className="flex items-center gap-2">
            {uploadError && <span className="text-xs text-red-400">{uploadError}</span>}
            {!currentFolder && (
              <button onClick={() => setShowNewFolder(true)}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800/60 px-3 py-2 text-sm text-neutral-300 transition hover:border-neutral-600 hover:bg-neutral-800">
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
                <span className="pointer-events-none absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-150" style={{ width: `${uploadProgress}%` }} />
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
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
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
                    ? "border-orange-400 bg-orange-400/10 scale-105"
                    : "border-neutral-700 opacity-60",
                ].join(" ")}
              >
                <span className="text-2xl">🏠</span>
                <span className="text-center text-xs text-neutral-500 leading-tight">Без папки</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Compact folder strip inside folder view (for drag targets) ── */}
      {currentFolderId !== null && isDragging && folders.length > 1 && (
        <div className="mb-4">
          <p className="mb-2 text-xs text-neutral-500">Перетягни до іншої папки:</p>
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
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-600",
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
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          {files.filter(f => f.folder_id === null).length > 0 ? `Файли без папки · ${files.filter(f => f.folder_id === null).length}` : ""}
        </p>
      )}

      {visibleFiles.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-neutral-500">
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
              : "border-neutral-700 text-neutral-600",
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
