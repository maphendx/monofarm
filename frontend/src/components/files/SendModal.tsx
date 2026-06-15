"use client";

import { Check, ChevronRight, Folder, FolderDown, ListPlus, Printer as PrinterIcon, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { API_URL, ApiError, api } from "@/lib/api";
import type { BambuQueuedResult, GcodeFile, GcodeFileMeta, GcodeFolder, Printer as PrinterType } from "@/lib/types";

// ── helpers (exported for use by other components) ────────────────────────────

export function usedSlotIndices(meta: GcodeFileMeta | null): number[] {
  if (!meta) return [];
  const total = Math.max(meta.colors?.length ?? 0, meta.types?.length ?? 0);
  if (total === 0) return [];
  const usedG = meta.used_g;
  if (!usedG || usedG.length === 0) return Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if ((usedG[i] ?? 1) > 0) out.push(i);
  }
  return out;
}

export function fmtMinutes(m: number): string {
  if (m < 60) return `${m} хв`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min > 0 ? `${h} г ${min} хв` : `${h} г`;
}

type SlotMatch = "ok" | "type_mismatch" | "missing";

function normalizeSlotColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const raw = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6,8}$/.test(raw)) return null;
  return `#${raw.slice(0, 6).toLowerCase()}`;
}

export function printerMaterialSlots(printer: PrinterType) {
  const slots = (printer.slots ?? [])
    .filter((s) => s.state !== "empty" && (s.filament_id || s.material || s.hex_color || s.color))
    .map((s) => ({
      slot: s.slot_index,
      type: s.material,
      color: s.hex_color ?? s.color,
      colorName: s.color,
    }));
  if (slots.length > 0) return slots;
  return (printer.loaded_filaments ?? [])
    .filter((s) => !s.empty && (s.filament_id || s.color || s.type))
    .map((s) => ({
      slot: s.slot,
      type: s.type,
      color: s.color,
      colorName: s.color_name,
    }));
}

function normalizeMaterial(type: string | null | undefined): string | null {
  const value = type?.trim().toLowerCase();
  return value || null;
}

export function slotLabel(slot: number) {
  return slot === 254 ? "Зовнішня котушка" : `Слот ${slot + 1}`;
}

export function autoMapSlots(meta: GcodeFileMeta | null, printer: PrinterType): Record<number, number> {
  const targets = printerMaterialSlots(printer);
  const usedTargets = new Set<number>();
  const map: Record<number, number> = {};

  for (const sourceSlot of usedSlotIndices(meta)) {
    const fileColor = normalizeSlotColor(meta?.colors?.[sourceSlot]);
    const fileType = normalizeMaterial(meta?.types?.[sourceSlot]);
    const candidates = targets.filter((t) => !usedTargets.has(t.slot));
    const exact = candidates.find((t) =>
      fileColor &&
      normalizeSlotColor(t.color) === fileColor &&
      (!fileType || !normalizeMaterial(t.type) || normalizeMaterial(t.type) === fileType)
    );
    const sameType = candidates.find((t) => fileType && normalizeMaterial(t.type) === fileType);
    const fallback = targets.find((t) => t.slot === sourceSlot && !usedTargets.has(t.slot))
      ?? candidates[0];
    const picked = exact ?? sameType ?? fallback;
    map[sourceSlot] = picked?.slot ?? sourceSlot;
    if (picked) usedTargets.add(picked.slot);
  }

  return map;
}

export function checkSlots(meta: GcodeFileMeta | null, printer: PrinterType) {
  if (!meta) return [];
  return usedSlotIndices(meta).map((i) => {
    const fileColor = meta.colors?.[i] ?? null;
    const fileType = meta.types?.[i] ?? null;
    const mappedSlot = autoMapSlots(meta, printer)[i] ?? i;
    const printerSlot = printerMaterialSlots(printer).find((s) => s.slot === mappedSlot);
    const printerColor = printerSlot?.color ?? null;
    const printerType = printerSlot?.type ?? null;
    let match: SlotMatch = "missing";
    if (printerSlot) {
      const typeOk = !fileType || !printerType || normalizeMaterial(fileType) === normalizeMaterial(printerType);
      match = typeOk ? "ok" : "type_mismatch";
    }
    return { slot: i + 1, targetSlot: mappedSlot + 1, fileColor, fileType, match, printerColor, printerType };
  });
}

export function compatBadge(slots: ReturnType<typeof checkSlots>) {
  if (slots.length === 0) return { label: "немає даних", cls: "bg-[var(--surface-hi)] text-[var(--text-muted)]" };
  const missing = slots.filter((s) => s.match === "missing").length;
  const mismatch = slots.filter((s) => s.match === "type_mismatch").length;
  if (missing === 0 && mismatch === 0) return { label: "сумісний ✓", cls: "badge badge-ok" };
  if (missing > 0) return { label: `${missing} слот${missing > 1 ? "и" : ""} відсутні`, cls: "badge badge-error" };
  return { label: `тип не збігається (${mismatch})`, cls: "badge badge-warn" };
}

export function fitCheck(meta: GcodeFileMeta | null, printer: PrinterType): "fits" | "oversize" | "unknown" {
  const sx = meta?.print_size_x;
  const sy = meta?.print_size_y;
  const sz = meta?.print_size_z;
  if (!sx && !sy && !sz) return "unknown";
  if (!printer.build_x && !printer.build_y && !printer.build_z) return "unknown";
  const TOL = 2;
  if (sx && printer.build_x && sx > printer.build_x + TOL) return "oversize";
  if (sy && printer.build_y && sy > printer.build_y + TOL) return "oversize";
  if (sz && printer.build_z && sz > printer.build_z + TOL) return "oversize";
  return "fits";
}

export function nozzleCheck(meta: GcodeFileMeta | null, printer: PrinterType): "ok" | "mismatch" | "unknown" {
  const fn = meta?.nozzle_diameter;
  const pn = printer.nozzle_diameter;
  if (!fn || !pn) return "unknown";
  return Math.abs(fn - pn) < 0.05 ? "ok" : "mismatch";
}

export function modelCheck(meta: GcodeFileMeta | null, printer: PrinterType, filename?: string): "ok" | "mismatch" | "unknown" {
  const fm = meta?.printer_model;
  const isBambuFormat = !fm && !!filename &&
    (filename.toLowerCase().endsWith(".gcode.3mf") || filename.toLowerCase().endsWith(".3mf"));
  if (!fm && !isBambuFormat) return "unknown";
  if (isBambuFormat) {
    if (printer.kind === "snapmaker_u1") return "mismatch";
    return "unknown";
  }
  function norm(s: string) {
    return s.toLowerCase().replace(/bambu\s*lab\s*/g, "").replace(/\s+/g, "");
  }
  const fn = norm(fm!);
  if (printer.kind === "bambu" && printer.bambu_model) {
    const pn = norm(printer.bambu_model);
    return fn.includes(pn) || pn.includes(fn) ? "ok" : "mismatch";
  }
  if (printer.kind === "snapmaker_u1") {
    return fn.includes("j1") || fn.includes("u1") || fn.includes("snapmaker") ? "ok" : "mismatch";
  }
  return "unknown";
}

function SlotSwatches({ meta }: { meta: GcodeFileMeta }) {
  const indices = usedSlotIndices(meta);
  if (indices.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {indices.map((i) => {
        const color = meta.colors?.[i] ?? null;
        const type  = meta.types?.[i] ?? null;
        const grams = meta.used_g?.[i];
        return (
          <div key={i} title={`Слот ${i + 1}`}
            className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            {color && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: color }} />}
            <span>Слот {i + 1}{type ? ` · ${type}` : ""}{grams != null ? ` · ${grams}г` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── printer cover images ──────────────────────────────────────────────────────

const BAMBU_COVER: [RegExp, string][] = [
  [/a1[\s_-]*mini/i,   "/printers/a1_mini.png"],
  [/a1[\s_-]*combo/i,  "/printers/a1_mini.png"],
  [/\ba1\b/i,          "/printers/a1.png"],
  [/p1s/i,             "/printers/p1s.png"],
  [/p1p/i,             "/printers/p1p.png"],
  [/x1[\s_-]*carbon/i, "/printers/x1c.png"],
  [/x1c/i,             "/printers/x1c.png"],
  [/x1e/i,             "/printers/x1e.png"],
  [/\bx1\b/i,          "/printers/x1.png"],
  [/h2d[\s_-]*pro/i,   "/printers/h2d_pro.png"],
  [/h2d/i,             "/printers/h2d.png"],
];

function printerCover(p: PrinterType): string | null {
  if (p.kind === "bambu") {
    for (const [re, path] of BAMBU_COVER)
      if (re.test(p.bambu_model ?? "")) return path;
  }
  if (p.kind === "snapmaker_u1") return "/printers/snapmaker_u1.png";
  return null;
}

// ── mode tab ──────────────────────────────────────────────────────────────────

type Mode = "print" | "save" | "queue";

const MODES: { key: Mode; label: string }[] = [
  { key: "print", label: "Друкувати зараз" },
  { key: "save",  label: "Зберегти" },
  { key: "queue", label: "У чергу" },
];

const CHOOSER_OPTIONS = [
  { key: "save"  as Mode, title: "Зберегти",    desc: "Файл уже в бібліотеці, повернешся до нього пізніше", icon: FolderDown },
  { key: "print" as Mode, title: "Друкувати",   desc: "Вибрати принтер, перевірити слоти й запустити друк", icon: PrinterIcon },
  { key: "queue" as Mode, title: "У чергу",     desc: "Додати як завдання з потрібною кількістю",           icon: ListPlus },
];

// ── SendModal ─────────────────────────────────────────────────────────────────

export function SendModal({
  file: fileProp,
  printers,
  onClose,
  defaultPrinterId,
  askMode = false,
  deleteOnCancel = false,
}: {
  file?: GcodeFile;
  printers: PrinterType[];
  onClose: () => void;
  defaultPrinterId?: number;
  askMode?: boolean;
  deleteOnCancel?: boolean;
}) {
  // ── file state ──
  const [pickedFile, setPickedFile] = useState<GcodeFile | null>(fileProp ?? null);
  const file = pickedFile;
  const showFilePicker = !pickedFile;

  // file picker
  const [allFiles, setAllFiles] = useState<GcodeFile[]>([]);
  const [folders, setFolders] = useState<GcodeFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(!fileProp);
  const [fileSearch, setFileSearch] = useState("");

  // ── mode state ──
  const [mode, setMode] = useState<Mode>("print");
  const [choosing, setChoosing] = useState(askMode);

  // ── cleanup (slicer upload) ──
  const keepFileRef = useRef(!deleteOnCancel);
  const cleanupStartedRef = useRef(false);
  const closeModalRef = useRef<(keep?: boolean) => void>(() => {});
  const resultOkRef = useRef(false);

  // ── print state ──
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    defaultPrinterId ? new Set([defaultPrinterId]) : new Set(),
  );
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());

  // ── results ──
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [queuedJob, setQueuedJob] = useState<BambuQueuedResult | null>(null);
  const [multiSendResults, setMultiSendResults] = useState<{ printerId: number; name: string; ok: boolean; message: string }[] | null>(null);

  // ── queue state ──
  const [quantity, setQuantity] = useState(1);

  // ── derived printer values ──
  const numSelected = selectedIds.size;
  const sendablePrinters = useMemo(
    () => printers.filter((p) => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id))),
    [printers],
  );
  const fileHasDimensions = !!(file?.filament_meta?.print_size_x || file?.filament_meta?.print_size_y || file?.filament_meta?.print_size_z);
  const compatiblePrinters = useMemo(
    () => fileHasDimensions ? sendablePrinters.filter((p) => fitCheck(file?.filament_meta ?? null, p) !== "oversize") : sendablePrinters,
    [sendablePrinters, fileHasDimensions, file?.filament_meta],
  );
  const primaryPrinter = useMemo(
    () => numSelected >= 1 ? (compatiblePrinters.find((p) => selectedIds.has(p.id)) ?? null) : null,
    [compatiblePrinters, selectedIds, numSelected],
  );
  const usedSlots = useMemo(() => usedSlotIndices(file?.filament_meta ?? null), [file?.filament_meta]);
  const isMoonraker = numSelected === 1 && !!primaryPrinter?.moonraker_url;

  const printerGroups = useMemo(() => {
    const groups = new Map<string, PrinterType[]>();
    for (const p of compatiblePrinters) {
      const key = p.group_name ?? "Принтери";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return groups;
  }, [compatiblePrinters]);

  // ── load files for picker ──
  useEffect(() => {
    if (fileProp) return;
    setLoadingFiles(true);
    Promise.all([api<GcodeFile[]>("/api/files"), api<GcodeFolder[]>("/api/folders")])
      .then(([files, fols]) => { setAllFiles(files); setFolders(fols); })
      .finally(() => setLoadingFiles(false));
  }, [fileProp]);

  // ── auto-map slots ──
  useEffect(() => {
    if (!file || !primaryPrinter) return;
    setSlotMap(autoMapSlots(file.filament_meta, primaryPrinter));
    setCalibrateSlots(new Set(usedSlots));
  }, [file?.filament_meta, primaryPrinter?.id, usedSlots]);

  // ── cleanup logic ──
  function keepFile() { keepFileRef.current = true; }

  async function cleanupPendingFile() {
    if (!deleteOnCancel || !fileProp || keepFileRef.current || cleanupStartedRef.current) return;
    cleanupStartedRef.current = true;
    try { await api(`/api/files/${fileProp.id}`, { method: "DELETE" }); } catch {}
  }

  function closeModal(keep = false) {
    if (keep) keepFile();
    onClose();
    void cleanupPendingFile();
  }

  useEffect(() => {
    closeModalRef.current = closeModal;
    resultOkRef.current = Boolean(result?.ok);
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeModalRef.current(resultOkRef.current);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    keepFileRef.current = !deleteOnCancel;
    cleanupStartedRef.current = false;
  }, [deleteOnCancel, fileProp?.id]);

  useEffect(() => {
    return () => {
      if (!deleteOnCancel || !fileProp || keepFileRef.current || cleanupStartedRef.current) return;
      cleanupStartedRef.current = true;
      void api(`/api/files/${fileProp.id}`, { method: "DELETE" }).catch(() => {});
    };
  }, [deleteOnCancel, fileProp?.id]);

  // ── handlers ──
  function switchMode(m: Mode) {
    setMode(m);
    setResult(null);
    setMultiSendResults(null);
  }

  function pickFile(f: GcodeFile) {
    setPickedFile(f);
    setResult(null);
    setMultiSendResults(null);
    setMode("print");
  }

  function togglePrinter(id: number) {
    if (multiSendResults) { setMultiSendResults(null); setResult(null); }
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function send() {
    if (!file || numSelected === 0 || busy) return;
    setBusy(true);
    setResult(null);
    setMultiSendResults(null);
    setQueuedJob(null);

    const targets = compatiblePrinters.filter((p) => selectedIds.has(p.id));

    if (targets.length === 1) {
      const p = targets[0];
      try {
        const apiSlotMap: Record<number, number> = {};
        for (const i of usedSlots) {
          const mapped = slotMap[i] ?? i;
          if (mapped !== i) apiSlotMap[i] = mapped;
        }
        const body: Record<string, unknown> = { slot_map: apiSlotMap };
        if (p.moonraker_url) {
          if (!autoBedLeveling) body.auto_bed_leveling = false;
          if (!timelapse)       body.timelapse = false;
          if (!aiDetection)     body.ai_detection = false;
          if (calibrateSlots.size !== usedSlots.length)
            body.calibrate_slots = Array.from(calibrateSlots).sort((a, b) => a - b);
        }
        const res = await api<{ ok: boolean; printer_name: string; message: string; dispatch_mode?: string; job_id?: number; printer_id?: number | null }>(
          `/api/files/${file.id}/send/${p.id}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        if (res.job_id != null) {
          keepFile();
          setQueuedJob(res as BambuQueuedResult);
          setResult({ ok: true, message: `Відправляється на «${res.printer_name}» — друк запуститься автоматично` });
        } else {
          if (res.ok) keepFile();
          setResult({ ok: res.ok, message: res.message });
        }
      } catch (e) {
        setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
      }
    } else {
      const settled = await Promise.allSettled(
        targets.map(async (p) => {
          const sm = autoMapSlots(file.filament_meta, p);
          const apiSlotMap: Record<number, number> = {};
          for (const i of usedSlotIndices(file.filament_meta)) {
            if ((sm[i] ?? i) !== i) apiSlotMap[i] = sm[i];
          }
          const res = await api<{ ok: boolean; message: string }>(
            `/api/files/${file.id}/send/${p.id}`,
            { method: "POST", body: JSON.stringify({ slot_map: apiSlotMap }) },
          );
          if (res.ok) keepFile();
          return { printerId: p.id, name: p.name, ok: res.ok, message: res.message };
        }),
      );
      setMultiSendResults(
        settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { printerId: targets[i].id, name: targets[i].name, ok: false, message: r.reason instanceof ApiError ? r.reason.message : "Помилка" },
        ),
      );
    }
    setBusy(false);
  }

  async function addToQueue() {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      await api("/api/queue/from-library", {
        method: "POST",
        body: JSON.stringify({ gcode_file_id: file.id, quantity }),
      });
      keepFile();
      setResult({ ok: true, message: `Додано в чергу (${quantity} шт.)` });
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally {
      setBusy(false);
    }
  }

  // ── file picker computed ──
  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const visibleFolders = fileSearch || currentFolderId !== null ? [] : folders;
  const visibleFiles = fileSearch
    ? allFiles.filter((f) => f.original_name.toLowerCase().includes(fileSearch.toLowerCase()))
    : allFiles.filter((f) => f.folder_id === currentFolderId);

  const allDone = result?.ok || (!!multiSendResults && multiSendResults.every((r) => r.ok));
  const canSend = numSelected > 0 && !!file && !busy && !allDone;
  const isPrintSplit = !choosing && mode === "print" && !showFilePicker;

  const modalWidth = showFilePicker
    ? "max-w-lg"
    : choosing ? "max-w-3xl"
    : isPrintSplit ? "max-w-7xl"
    : "max-w-sm";

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={() => closeModal(Boolean(result?.ok))}
    >
      <div
        className={`flex w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl ${modalWidth}`}
        style={{ maxHeight: "90vh", height: isPrintSplit ? "82vh" : undefined }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="relative flex shrink-0 items-center border-b border-[var(--border)] px-4 py-3">
          {!fileProp && pickedFile && (
            <button
              onClick={() => { setPickedFile(null); setResult(null); setMultiSendResults(null); }}
              className="mr-2 flex size-7 shrink-0 items-center justify-center rounded-lg text-sm text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
            >
              ←
            </button>
          )}
          <div className="flex-1 text-center">
            <h2 className={`font-semibold ${choosing ? "text-xl" : "text-sm"}`}>
              {showFilePicker ? "Вибери файл" : choosing ? "Що зробити з файлом?" : "Файл завантажено"}
            </h2>
            {!showFilePicker && file && !choosing && (
              <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{file.original_name}</p>
            )}
            {showFilePicker && currentFolder && (
              <p className="mt-0.5 text-[11px] text-[var(--text-faint)]">{currentFolder.name}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => closeModal(Boolean(result?.ok))}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-lg text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        {/* ── File picker screen ── */}
        {showFilePicker ? (
          <>
            <div className="shrink-0 border-b border-[var(--border)] px-4 py-2.5">
              <input
                type="text" value={fileSearch} onChange={(e) => setFileSearch(e.target.value)}
                placeholder="Пошук файлів…" autoFocus
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {loadingFiles ? (
                <p className="py-12 text-center text-sm text-[var(--text-faint)]">Завантаження…</p>
              ) : (
                <>
                  {visibleFolders.length > 0 && (
                    <div className="mb-3 grid grid-cols-2 gap-2">
                      {visibleFolders.map((folder) => (
                        <button key={folder.id}
                          onClick={() => { setCurrentFolderId(folder.id); setFileSearch(""); }}
                          className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2.5 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]"
                        >
                          <Folder size={16} className="shrink-0 text-[var(--accent)]" />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{folder.name}</p>
                            <p className="text-[10px] text-[var(--text-faint)]">{folder.file_count} файл{folder.file_count === 1 ? "" : "ів"}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {visibleFiles.length === 0 ? (
                    <p className="py-8 text-center text-sm text-[var(--text-faint)]">
                      {allFiles.length === 0 ? "Файлів ще немає" : fileSearch ? "Нічого не знайдено" : "Папка порожня"}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {visibleFiles.map((f) => (
                        <button key={f.id} onClick={() => pickFile(f)}
                          className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-[var(--surface-hi)]"
                        >
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[10px] font-mono text-[var(--text-muted)]">
                            {f.has_thumbnail
                              ? <img src={`${API_URL}/api/files/${f.id}/thumbnail`} alt="" className="h-full w-full object-cover" />
                              : (f.original_name.includes(".") ? f.original_name.split(".").pop()!.toUpperCase() : "?")}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{f.original_name}</p>
                            <div className="mt-0.5 flex items-center gap-2">
                              {f.filament_meta?.estimated_minutes && (
                                <span className="text-[10px] text-[var(--text-faint)]">~{fmtMinutes(f.filament_meta.estimated_minutes)}</span>
                              )}
                              {f.filament_meta?.colors && f.filament_meta.colors.length > 0 && (
                                <span className="flex gap-0.5">
                                  {f.filament_meta.colors.slice(0, 4).map((c, ci) => (
                                    <span key={ci} className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: c ?? "#ccc" }} />
                                  ))}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight size={13} className="shrink-0 text-[var(--text-faint)]" />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Mode tabs */}
            {!choosing && (
              <div className="flex shrink-0 border-b border-[var(--border)]">
                {MODES.map((m) => (
                  <button key={m.key} onClick={() => switchMode(m.key)}
                    className={[
                      "flex-1 py-2 text-xs font-medium transition",
                      mode === m.key
                        ? "border-b-2 border-[var(--border-strong)] text-[var(--text-hi)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text)]",
                    ].join(" ")}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}

            {/* Filament meta row (save/queue/chooser; print mode shows it in LEFT panel) */}
            {file?.filament_meta && (choosing || mode !== "print") && (
              <div className="shrink-0 border-b border-[var(--border)] px-5 pb-4 pt-3">
                <SlotSwatches meta={file.filament_meta} />
                <p className="mt-1.5 text-xs text-[var(--text-faint)]">
                  {file.filament_meta.estimated_minutes && `~${fmtMinutes(file.filament_meta.estimated_minutes)}`}
                  {file.filament_meta.total_layers && ` · ${file.filament_meta.total_layers} шарів`}
                  {file.filament_meta.layer_height && ` · h ${file.filament_meta.layer_height} мм`}
                  {file.filament_meta.nozzle_diameter && ` · ∅${file.filament_meta.nozzle_diameter} мм`}
                  {(file.filament_meta.print_size_x || file.filament_meta.print_size_y || file.filament_meta.print_size_z) && (
                    <span className="ml-1">
                      · {[file.filament_meta.print_size_x, file.filament_meta.print_size_y, file.filament_meta.print_size_z]
                        .map((v) => (v != null ? `${v}` : "?")).join("×")} мм
                    </span>
                  )}
                  {file.filament_meta.printer_model && (
                    <span className="ml-1 text-[var(--accent)]">· {file.filament_meta.printer_model}</span>
                  )}
                </p>
              </div>
            )}

            {/* ── PRINT MODE: split panel ── */}
            {isPrintSplit && (
              <div className="flex flex-1 overflow-hidden">

                {/* LEFT: settings */}
                <div className="flex w-72 shrink-0 flex-col border-r border-[var(--border)]">
                  <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">

                    {/* File summary */}
                    {file && (
                      <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] text-[9px] font-mono text-[var(--text-muted)]">
                          {file.has_thumbnail
                            ? <img src={`${API_URL}/api/files/${file.id}/thumbnail`} alt="" className="h-full w-full object-cover" />
                            : file.original_name.split(".").pop()!.toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{file.original_name}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            {file.filament_meta?.estimated_minutes && (
                              <span className="text-[10px] text-[var(--text-faint)]">~{fmtMinutes(file.filament_meta.estimated_minutes)}</span>
                            )}
                            {file.filament_meta?.colors && file.filament_meta.colors.length > 0 && (
                              <span className="flex gap-0.5">
                                {file.filament_meta.colors.slice(0, 5).map((c, ci) => (
                                  <span key={ci} className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: c ?? "#ccc" }} />
                                ))}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {numSelected === 0 && (
                      <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-6 text-center">
                        <p className="text-xs text-[var(--text-faint)]">Вибери принтер →</p>
                      </div>
                    )}

                    {numSelected > 1 && (
                      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
                        <p className="text-[11px] font-medium text-[var(--text-muted)]">Авто-маппінг · {numSelected} принтери</p>
                        <p className="mt-1 text-[10px] text-[var(--text-faint)]">Кожен принтер отримає автоматично підібрані слоти.</p>
                      </div>
                    )}

                    {/* Slot mapping (single printer) */}
                    {numSelected === 1 && usedSlots.length > 0 && primaryPrinter && file && (
                      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                        <div className="mb-2.5 flex items-center justify-between">
                          <p className="text-[11px] font-medium text-[var(--text-muted)]">Маппінг котушок</p>
                          <button
                            onClick={() => setSlotMap(autoMapSlots(file.filament_meta, primaryPrinter))}
                            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)]"
                          >
                            Авто
                          </button>
                        </div>
                        <div className="space-y-3">
                          {usedSlots.map((i) => {
                            const fileColor = file.filament_meta?.colors?.[i] ?? null;
                            const fileType  = file.filament_meta?.types?.[i] ?? null;
                            const grams     = file.filament_meta?.used_g?.[i];
                            const matSlots  = printerMaterialSlots(primaryPrinter);
                            const currentTarget = slotMap[i] ?? i;
                            return (
                              <div key={i}>
                                <div className="mb-1 flex items-center gap-1.5">
                                  {fileColor && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                                  <span className="text-[10px] text-[var(--text-muted)]">
                                    Слот {i + 1}{fileType ? ` · ${fileType}` : ""}{grams != null ? ` · ${grams}г` : ""}
                                  </span>
                                </div>
                                {matSlots.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {matSlots.map((s) => {
                                      const isSel = currentTarget === s.slot;
                                      return (
                                        <button key={s.slot} type="button"
                                          onClick={() => setSlotMap((prev) => ({ ...prev, [i]: s.slot }))}
                                          className={[
                                            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition",
                                            isSel
                                              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                                              : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                                          ].join(" ")}
                                        >
                                          {s.color && <span className="h-2 w-2 shrink-0 rounded-full border border-black/20" style={{ background: s.color }} />}
                                          {slotLabel(s.slot)}{s.type ? ` · ${s.type}` : ""}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <select value={currentTarget}
                                    onChange={(e) => setSlotMap((prev) => ({ ...prev, [i]: Number(e.target.value) }))}
                                    className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] outline-none"
                                  >
                                    {Array.from({ length: 4 }).map((_, s) => (
                                      <option key={s} value={s}>Слот {s + 1}</option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Moonraker options */}
                    {isMoonraker && file && (
                      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
                        <p className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">Опції</p>
                        <div className="space-y-1.5">
                          {([
                            [autoBedLeveling, setAutoBedLeveling, "Автокалібрування"] as const,
                            [timelapse,       setTimelapse,       "Таймлапс"] as const,
                            [aiDetection,     setAiDetection,     "AI детекція"] as const,
                          ] as const).map(([checked, setter, label]) => (
                            <label key={label} className="flex cursor-pointer items-center gap-2 text-[11px]">
                              <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} />
                              <span className="text-[var(--text)]">{label}</span>
                            </label>
                          ))}
                        </div>
                        {usedSlots.length > 0 && (
                          <>
                            <p className="mb-1.5 mt-3 text-[11px] font-medium text-[var(--text-muted)]">Калібрувати</p>
                            <div className="space-y-1">
                              {usedSlots.map((i) => {
                                const fileColor = file.filament_meta?.colors?.[i] ?? null;
                                const fileType  = file.filament_meta?.types?.[i] ?? null;
                                return (
                                  <label key={i} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                                    <input type="checkbox" checked={calibrateSlots.has(i)}
                                      onChange={() => setCalibrateSlots((prev) => {
                                        const n = new Set(prev);
                                        if (n.has(i)) n.delete(i); else n.add(i);
                                        return n;
                                      })}
                                      className=""
                                    />
                                    {fileColor && <span className="h-2 w-2 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                                    <span className="truncate text-[var(--text)]">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Result */}
                    {result && (
                      <div className={["rounded-xl px-3 py-2.5 text-xs",
                        result.ok
                          ? "border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                          : "border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",
                      ].join(" ")}>
                        {result.ok ? "✓ " : "✕ "}{result.message}
                        {queuedJob && queuedJob.printer_id != null && (
                          <Link href={`/printers/${queuedJob.printer_id}`} onClick={() => closeModal(true)}
                            className="mt-1 block text-xs font-medium underline hover:no-underline">
                            Переглянути завдання →
                          </Link>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="shrink-0 space-y-2 border-t border-[var(--border)] px-4 py-3">
                    {!allDone && (
                      <button onClick={send} disabled={!canSend}
                        className="btn btn-primary w-full disabled:opacity-40">
                        {busy
                          ? "Надсилаю…"
                          : numSelected === 0 ? "Вибери принтер"
                          : numSelected === 1 ? `▶ ${primaryPrinter?.name ?? "Надіслати"}`
                          : `▶ Надіслати на ${numSelected}`}
                      </button>
                    )}
                    <button onClick={() => closeModal(Boolean(result?.ok))} className="btn btn-ghost w-full">
                      {allDone ? "Закрити" : "Скасувати"}
                    </button>
                  </div>
                </div>

                {/* RIGHT: printer grid */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                  {compatiblePrinters.length === 0 ? (
                    <p className="py-12 text-center text-sm text-[var(--text-faint)]">
                      {fileHasDimensions && sendablePrinters.length > 0
                        ? "Немає принтерів з достатнім столом"
                        : "Немає доступних принтерів"}
                    </p>
                  ) : (
                    <div className="space-y-5">
                      <p className="text-[11px] text-[var(--text-faint)]">Клікни щоб вибрати один або декілька принтерів</p>
                      {[...printerGroups.entries()].map(([groupName, groupPrinters]) => (
                        <div key={groupName}>
                          {printerGroups.size > 1 && (
                            <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{groupName}</p>
                          )}
                          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                            {groupPrinters.map((p) => {
                              const slots    = checkSlots(file?.filament_meta ?? null, p);
                              const compat   = compatBadge(slots);
                              const fit      = fitCheck(file?.filament_meta ?? null, p);
                              const nozzle   = nozzleCheck(file?.filament_meta ?? null, p);
                              const model    = modelCheck(file?.filament_meta ?? null, p, file?.original_name);
                              const matSlots = printerMaterialSlots(p);
                              const isSelected = selectedIds.has(p.id);
                              const cover    = printerCover(p);
                              const res      = multiSendResults?.find((r) => r.printerId === p.id);
                              const isOffline = p.state === "offline" || p.state === "unknown";
                              return (
                                <button key={p.id} onClick={() => togglePrinter(p.id)}
                                  className={[
                                    "relative flex flex-col overflow-hidden rounded-xl border text-left transition",
                                    isSelected
                                      ? "border-[var(--accent)] shadow-md ring-1 ring-[var(--accent)]"
                                      : "border-[var(--border)] hover:border-[var(--border-strong)] hover:shadow-sm",
                                  ].join(" ")}
                                >
                                  {/* Photo */}
                                  <div className={`relative h-40 w-full overflow-hidden ${cover ? "bg-[var(--surface-hi)]" : "bg-gradient-to-br from-[var(--surface-hi)] to-[var(--bg)]"}`}>
                                    {cover ? (
                                      <img src={cover} alt={p.name}
                                        className="h-full w-full object-contain p-4"
                                        style={{ opacity: isOffline ? 0.45 : 1, filter: isOffline ? "grayscale(0.7)" : undefined }}
                                      />
                                    ) : (
                                      <div className="flex h-full items-center justify-center">
                                        <span className="text-5xl font-black text-[var(--border-strong)]">{p.name.charAt(0).toUpperCase()}</span>
                                      </div>
                                    )}
                                    {/* State pill */}
                                    <span className={[
                                      "absolute left-2 top-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm",
                                      p.state === "idle" || p.state === "operational" ? "bg-[rgba(34,197,94,.18)] text-[var(--state-ok)]"
                                        : p.state === "printing" ? "bg-[rgba(59,130,246,.18)] text-[var(--state-print)]"
                                        : p.state === "error" ? "bg-[rgba(239,68,68,.18)] text-[var(--state-error)]"
                                        : "bg-black/25 text-white/70",
                                    ].join(" ")}>
                                      <span className={`h-1.5 w-1.5 rounded-full ${
                                        p.state === "idle" || p.state === "operational" ? "bg-[var(--state-ok)]"
                                          : p.state === "printing" ? "bg-[var(--state-warn)]"
                                          : p.state === "error" ? "bg-[var(--state-error)]"
                                          : "bg-[var(--state-offline)]"}`} />
                                      {p.state === "idle" || p.state === "operational" ? "Вільний"
                                        : p.state === "printing" ? `${p.progress_pct ?? 0}%`
                                        : p.state === "error" ? "Помилка"
                                        : p.state === "paused" ? "Пауза" : "Офлайн"}
                                    </span>
                                    {/* Checkbox */}
                                    <span className={[
                                      "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded border-2 shadow transition-all",
                                      isSelected ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-white/50 bg-black/25",
                                    ].join(" ")}>
                                      {isSelected && <Check size={10} strokeWidth={3.5} />}
                                    </span>
                                    {/* Result overlay */}
                                    {res && (
                                      <div className={[
                                        "absolute inset-0 flex items-center justify-center text-2xl font-black",
                                        res.ok ? "bg-[rgba(34,197,94,.3)]" : "bg-[rgba(239,68,68,.3)]",
                                      ].join(" ")}>
                                        {res.ok ? "✓" : "✕"}
                                      </div>
                                    )}
                                  </div>
                                  {/* Info */}
                                  <div className={`flex flex-col gap-2 p-3.5 ${isSelected ? "bg-[var(--surface-hi)]" : "bg-[var(--bg-elevated)]"}`}>
                                    <p className="truncate text-base font-semibold">{p.name}</p>
                                    {(p.build_x || p.nozzle_diameter) && (
                                      <p className="text-xs text-[var(--text-faint)]">
                                        {p.build_x && p.build_y ? `${p.build_x}×${p.build_y}мм` : ""}
                                        {p.nozzle_diameter ? ` · ∅${p.nozzle_diameter}мм` : ""}
                                      </p>
                                    )}
                                    {matSlots.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {matSlots.slice(0, 4).map((s) => (
                                          <span key={s.slot} className="flex items-center gap-0.5 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                                            {s.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />}
                                            {s.type ?? slotLabel(s.slot)}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    <div className="flex flex-wrap gap-1 empty:hidden">
                                      {fit === "oversize"    && <span className="badge badge-error text-[9px]">✕ не влазить</span>}
                                      {nozzle === "mismatch" && <span className="badge badge-warn text-[9px]">∅≠</span>}
                                      {model === "mismatch"  && <span className="badge badge-warn text-[9px]">⚠ модель</span>}
                                      <span className={`${compat.cls} text-[9px]`}>{compat.label}</span>
                                    </div>
                                    {res && (
                                      <p className={`text-[10px] font-medium ${res.ok ? "text-[var(--state-ok)]" : "text-[var(--state-error)]"}`}>
                                        {res.ok ? "✓" : "✕"} {res.message}
                                      </p>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── SAVE / QUEUE / CHOOSER modes ── */}
            {(choosing || mode === "save" || mode === "queue") && (
              <>
                <div className="flex-1 overflow-y-auto">
                  <div className="space-y-4 px-5 py-4">
                    {choosing && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        {CHOOSER_OPTIONS.map((o) => {
                          const Icon = o.icon;
                          return (
                            <button key={o.key} type="button"
                              onClick={() => { setChoosing(false); switchMode(o.key); }}
                              className="group flex min-h-40 flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg)] p-5 text-center transition hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]">
                              <span className="mb-3 flex size-12 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] transition group-hover:text-[var(--accent)]">
                                <Icon size={27} strokeWidth={1.8} />
                              </span>
                              <p className="text-lg font-semibold text-[var(--text-hi)]">{o.title}</p>
                              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{o.desc}</p>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {!choosing && mode === "save" && (
                      <p className="text-sm text-[var(--text-muted)]">
                        {deleteOnCancel
                          ? "Натисни «Готово», щоб залишити файл у бібліотеці. Якщо скасувати, файл буде видалено."
                          : "Файл вже збережено в бібліотеці. Ви можете надіслати його на принтер пізніше."}
                      </p>
                    )}

                    {!choosing && mode === "queue" && !result && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <label className="text-sm text-[var(--text)]">Кількість</label>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                              className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] text-sm hover:bg-[var(--surface-hi)]">−</button>
                            <span className="w-8 text-center text-sm font-medium">{quantity}</span>
                            <button onClick={() => setQuantity((q) => q + 1)}
                              className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] text-sm hover:bg-[var(--surface-hi)]">+</button>
                          </div>
                          <span className="text-xs text-[var(--text-faint)]">шт.</span>
                        </div>
                      </div>
                    )}

                    {result && (
                      <div className={["rounded-lg px-3 py-2 text-sm",
                        result.ok
                          ? "border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                          : "border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",
                      ].join(" ")}>
                        {result.ok ? "✓ " : "✕ "}{result.message}
                        {result.ok && mode === "queue" && (
                          <Link href="/queue" onClick={() => closeModal(true)}
                            className="mt-1 block text-sm font-medium underline hover:no-underline">
                            Перейти до черги →
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
                  <button onClick={() => closeModal(Boolean(result?.ok))} className="btn btn-ghost">
                    {result?.ok ? "Закрити" : "Скасувати"}
                  </button>
                  {!choosing && !result?.ok && mode === "save" && (
                    <button onClick={() => closeModal(true)} className="btn btn-primary">Готово</button>
                  )}
                  {!choosing && !result?.ok && mode === "queue" && (
                    <button onClick={addToQueue} disabled={busy || !file}
                      className="btn btn-primary disabled:opacity-40">
                      {busy ? "Додаю…" : "Додати в чергу"}
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
