"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TagBadge, type Tag as TagType } from "@/components/ui/TagBadge";
import { ApiError, api, getToken } from "@/lib/api";
import { SendModal, checkSlots, compatBadge, fitCheck, modelCheck, nozzleCheck } from "@/components/files/SendModal";
import { CardsSkeleton } from "@/components/ui/ContentSkeleton";
import { useUser } from "@/lib/auth-context";
import { usePrinterStream } from "@/hooks/usePrinterStream";
import { preferRealtimePrinters } from "@/lib/printerSlots";
import type { GcodeFile, GcodeFileMeta, GcodeFolder, Printer, PrinterGroup } from "@/lib/types";
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

// ── Compat helpers ─────────────────────────────────────────────────────────────
function groupCompat(meta: GcodeFileMeta | null, g: PrinterGroup, groupPrinters: Printer[], filename?: string): "ok" | "warn" | "error" | "unknown" {
  // If every printer in the group is a model mismatch, hide the badge entirely.
  if (groupPrinters.length > 0) {
    const models = groupPrinters.map(p => modelCheck(meta, p, filename));
    if (models.every(r => r === "mismatch")) return "unknown";
  }
  const hasSpecs = g.nozzle_diameter || g.build_x || g.supported_materials?.length;
  if (!hasSpecs) return "unknown";
  const TOL = 2;
  if (meta?.print_size_x && g.build_x && meta.print_size_x > g.build_x + TOL) return "error";
  if (meta?.print_size_y && g.build_y && meta.print_size_y > g.build_y + TOL) return "error";
  if (meta?.print_size_z && g.build_z && meta.print_size_z > g.build_z + TOL) return "error";
  if (meta?.nozzle_diameter && g.nozzle_diameter && Math.abs(meta.nozzle_diameter - g.nozzle_diameter) > 0.05) return "warn";
  if (g.supported_materials?.length && meta?.types?.length) {
    const sup = g.supported_materials.map(m => m.toLowerCase());
    if (meta.types.some(t => t && !sup.includes(t.toLowerCase()))) return "warn";
  }
  return "ok";
}

// ── Group compat badges (primary) ─────────────────────────────────────────────
function GroupCompatBadges({ file, groups, printers, onSend }: {
  file: GcodeFile; groups: PrinterGroup[]; printers: Printer[]; onSend: (p: Printer | null, groupId?: number) => void;
}) {
  const groupsWithSpecs = groups.filter(g => g.nozzle_diameter || g.build_x || g.supported_materials?.length);

  if (groupsWithSpecs.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {groupsWithSpecs.map(g => {
          const gPrinters = printers.filter(p => p.group_id === g.id);
          const compat = groupCompat(file.filament_meta, g, gPrinters, file.original_name);
          const dot = g.color ? { background: g.color } : undefined;
          let cls: string;
          let indicator: string;
          let tip: string;
          if (compat === "error") {
            cls = "bg-[rgba(239,68,68,.10)] text-[var(--state-error)] border border-[rgba(239,68,68,.2)]";
            indicator = "✕";
            tip = `${g.name}: не влазить у стіл`;
          } else if (compat === "warn") {
            cls = "bg-[rgba(234,179,8,.10)] text-[var(--state-warn)] border border-[rgba(234,179,8,.2)]";
            indicator = "~";
            tip = `${g.name}: часткова сумісність`;
          } else if (compat === "ok") {
            cls = "bg-[rgba(34,197,94,.10)] text-[var(--state-ok)] border border-[rgba(34,197,94,.2)]";
            indicator = "✓";
            tip = `${g.name}: сумісна група`;
          } else {
            return null;
          }
          return (
            <button key={g.id} type="button" title={tip}
              onClick={e => { e.stopPropagation(); onSend(null, g.id); }}
              className={`flex max-w-[84px] items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition hover:opacity-80 ${cls}`}>
              {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={dot} />}
              <span className="truncate">{indicator} {g.name}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // fallback: individual printer dots when no groups have specs
  const sendable = printers.filter(p => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)));
  if (!sendable.length) return null;
  const visible = sendable.slice(0, 6);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map(p => {
        const fit = fitCheck(file.filament_meta, p);
        const nozzle = nozzleCheck(file.filament_meta, p);
        const model = modelCheck(file.filament_meta, p, file.original_name);
        const slots = checkSlots(file.filament_meta, p);
        const hasMissing = slots.some(s => s.match === "missing");
        const hasMismatch = slots.some(s => s.match === "type_mismatch");
        let cls: string;
        let tip: string;
        if (fit === "oversize") {
          cls = "bg-[rgba(239,68,68,.10)] text-[var(--state-error)] border border-[rgba(239,68,68,.2)]";
          tip = `${p.name}: не влазить`;
        } else if (model === "mismatch") {
          cls = "bg-[rgba(234,179,8,.10)] text-[var(--state-warn)] border border-[rgba(234,179,8,.2)]";
          tip = `${p.name}: нарізано для іншої моделі`;
        } else if (model === "ok") {
          cls = "bg-[rgba(34,197,94,.10)] text-[var(--state-ok)] border border-[rgba(34,197,94,.2)]";
          tip = `${p.name}: модель збігається`;
        } else if (nozzle === "mismatch" || hasMissing) {
          cls = "bg-[rgba(234,179,8,.10)] text-[var(--state-warn)] border border-[rgba(234,179,8,.2)]";
          tip = `${p.name}: часткова сумісність`;
        } else if (hasMismatch) {
          cls = "bg-[rgba(234,179,8,.10)] text-[var(--state-warn)] border border-[rgba(234,179,8,.2)]";
          tip = `${p.name}: тип матеріалу`;
        } else if (fit === "fits" || slots.some(s => s.match === "exact" || s.match === "close" || s.match === "type_only")) {
          cls = "bg-[rgba(34,197,94,.10)] text-[var(--state-ok)] border border-[rgba(34,197,94,.2)]";
          tip = `${p.name}: сумісний`;
        } else {
          cls = "bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)]";
          tip = p.name;
        }
        return (
          <button key={p.id} type="button" title={tip}
            onClick={e => { e.stopPropagation(); onSend(p); }}
            className={`flex max-w-[72px] items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium transition hover:opacity-80 ${cls}`}>
            <span className="truncate">{p.name}</span>
          </button>
        );
      })}
      {sendable.length > 6 && <span className="text-[10px] text-[var(--text-faint)]">+{sendable.length - 6}</span>}
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
        "group relative flex cursor-pointer select-none flex-col items-center gap-3 rounded-xl border p-4 transition duration-150",
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
function FileCard({ file, printers, groups, canEdit, highlighted, isDragging, onSend, onSendTo, onDelete, onDragStart, onDragEnd }: {
  file: GcodeFile; printers: Printer[]; groups: PrinterGroup[]; canEdit: boolean; highlighted: boolean; isDragging: boolean;
  onSend: () => void; onSendTo: (p: Printer | null, groupId?: number) => void; onDelete: () => void;
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
        "group relative flex flex-col gap-2 rounded-xl border p-3 transition duration-150",
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

      {/* tags */}
      {file.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {file.tags.map(t => <TagBadge key={t.id} tag={t as TagType} />)}
        </div>
      )}
      {/* filament swatches */}
      {file.filament_meta && <SlotSwatches meta={file.filament_meta} />}

      {/* analysis row */}
      {file.filament_meta && (
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          {file.filament_meta.estimated_minutes && `~${fmtMinutes(file.filament_meta.estimated_minutes)}`}
          {file.filament_meta.total_layers ? ` · ${file.filament_meta.total_layers}L` : ""}
          {file.filament_meta.layer_height ? ` · h${file.filament_meta.layer_height}` : ""}
          {file.filament_meta.nozzle_diameter ? ` · ∅${file.filament_meta.nozzle_diameter}` : ""}
          {(file.filament_meta.print_size_x || file.filament_meta.print_size_y || file.filament_meta.print_size_z) ?
            ` · ${[file.filament_meta.print_size_x, file.filament_meta.print_size_y, file.filament_meta.print_size_z].map(v => v != null ? v : "?").join("×")}мм` : ""}
          {file.filament_meta.printer_model && (
            <span className="text-[var(--accent)]"> · {file.filament_meta.printer_model.replace(/^Bambu\s*Lab\s*/i, "")}</span>
          )}
        </p>
      )}

      {/* group / printer compat badges */}
      <GroupCompatBadges file={file} groups={groups} printers={printers} onSend={onSendTo} />

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
        "flex items-center justify-center gap-2 rounded-xl border-2 border-dashed py-3 px-4 text-sm transition duration-150",
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
  const [restPrinters, setRestPrinters] = useState<Printer[]>([]);
  const { printers: realtimePrinters, loading: realtimePrintersLoading } = usePrinterStream();
  const printers = preferRealtimePrinters(restPrinters, realtimePrinters, realtimePrintersLoading);
  const [printerGroups, setPrinterGroups] = useState<PrinterGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "parsing">("uploading");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendFile, setSendFile] = useState<GcodeFile | null>(null);
  const [defaultPrinterOverride, setDefaultPrinterOverride] = useState<number | null>(null);
  // Slicer (Orca) auto-open shows a save / print / queue chooser first
  const [sendAskMode, setSendAskMode] = useState(false);
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
  const dismissedAutoOpenFileIdRef = useRef<number | null>(null);

  // ── Load ──
  const load = useCallback(async () => {
    try {
      const [f, p, fols, grps] = await Promise.all([
        api<GcodeFile[]>("/api/files"),
        api<Printer[]>("/api/printers"),
        api<GcodeFolder[]>("/api/folders"),
        api<PrinterGroup[]>("/api/printer-groups"),
      ]);
      setFiles(f); setRestPrinters(p); setFolders(fols); setPrinterGroups(grps);
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
      if (dismissedAutoOpenFileIdRef.current === target.id) return;
      setCurrentFolderId(target.folder_id ?? null);
      setSendAskMode(true);
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
    setUploading(true); setUploadProgress(0); setUploadError(null); setUploadPhase("uploading");
    try {
      const form = new FormData();
      form.append("file", file);
      const path = currentFolderId ? `/api/files/upload?folder_id=${currentFolderId}` : "/api/files/upload";
      const saved = await uploadWithProgress<GcodeFile>(path, form, pct => {
        setUploadProgress(pct);
        if (pct >= 99) setUploadPhase("parsing");
      });
      setFiles(prev => [saved, ...prev]);
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
      setSendAskMode(false);
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
                <span
                  className={["pointer-events-none absolute inset-y-0 left-0 bg-[var(--bg-elevated)]/20 transition-[width] duration-300", uploadPhase === "parsing" ? "animate-pulse" : ""].join(" ")}
                  style={{ width: uploadPhase === "parsing" ? "100%" : `${uploadProgress}%` }}
                />
              )}
              <span className="relative flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" style={{ display: uploading ? undefined : "none" }} />
                {!uploading && <span>↑</span>}
                {uploading ? (uploadPhase === "parsing" ? "Обробка…" : `${uploadProgress}%`) : "Завантажити"}
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
                  "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 transition duration-150 cursor-default",
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
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition duration-150 cursor-default select-none",
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
              printers={printers}
              groups={printerGroups}
              canEdit={canEdit}
              highlighted={f.id === highlightId}
              isDragging={draggedFile?.id === f.id}
              onSend={() => { setSendAskMode(false); setSendFile(f); }}
              onSendTo={(p, groupId) => {
                setSendAskMode(false);
                setSendFile(f);
                if (p) {
                  setDefaultPrinterOverride(p.id);
                } else if (groupId) {
                  // pre-select first compatible active printer in the group
                  const first = printers.find(pr => pr.is_active && pr.group_id === groupId && (pr.moonraker_url || (pr.kind === "bambu" && pr.bambu_dev_id)));
                  setDefaultPrinterOverride(first?.id ?? null);
                }
              }}
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
            "mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-16 transition",
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
        <SendModal
          file={sendFile}
          printers={printers}
          onClose={() => {
            dismissedAutoOpenFileIdRef.current = sendFile.id;
            setSendAskMode(false);
            setSendFile(null);
            setDefaultPrinterOverride(null);
          }}
          defaultPrinterId={defaultPrinterOverride ?? defaultPrinterId ?? undefined}
          askMode={sendAskMode}
        />
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
