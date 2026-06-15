"use client";

import { Check, ChevronRight, Folder, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  autoMapSlots,
  checkSlots,
  compatBadge,
  fitCheck,
  fmtMinutes,
  modelCheck,
  nozzleCheck,
  printerMaterialSlots,
  slotLabel,
  usedSlotIndices,
} from "@/components/files/SendModal";
import { API_URL, ApiError, api } from "@/lib/api";
import type { GcodeFile, GcodeFolder, Printer } from "@/lib/types";

// ── printer cover images (same logic as dashboard) ──────────────────────────

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

function printerCover(p: Printer): string | null {
  if (p.kind === "bambu") {
    for (const [re, path] of BAMBU_COVER)
      if (re.test(p.bambu_model ?? "")) return path;
  }
  if (p.kind === "snapmaker_u1") return "/printers/snapmaker_u1.png";
  return null;
}

function stateDot(p: Printer) {
  switch (p.state) {
    case "idle": case "operational": return "bg-[var(--state-ok)]";
    case "printing":  return "bg-[var(--state-warn)]";
    case "error":     return "bg-[var(--state-error)]";
    default:          return "bg-[var(--state-offline)]";
  }
}

function stateLabel(p: Printer) {
  switch (p.state) {
    case "idle": case "operational": return "Вільний";
    case "printing": return `${p.progress_pct ?? 0}%`;
    case "error":    return "Помилка";
    case "paused":   return "Пауза";
    default:         return "Офлайн";
  }
}

// ── component ────────────────────────────────────────────────────────────────

export function PrintLaunchModal({
  printers,
  defaultPrinterId,
  onClose,
}: {
  printers: Printer[];
  defaultPrinterId?: number;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"file" | "configure">("file");

  const [selectedFile, setSelectedFile] = useState<GcodeFile | null>(null);
  const [selectedPrinterIds, setSelectedPrinterIds] = useState<Set<number>>(
    defaultPrinterId ? new Set([defaultPrinterId]) : new Set(),
  );

  // File picker
  const [allFiles, setAllFiles] = useState<GcodeFile[]>([]);
  const [folders, setFolders] = useState<GcodeFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [search, setSearch] = useState("");

  // Launch settings
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [multiResults, setMultiResults] = useState<{ printerId: number; name: string; ok: boolean; message: string }[] | null>(null);

  const numSelected = selectedPrinterIds.size;

  // Primary printer = first selected (used for slot mapping preview)
  const primaryPrinter = useMemo(
    () => numSelected >= 1 ? (printers.find((p) => selectedPrinterIds.has(p.id)) ?? null) : null,
    [printers, selectedPrinterIds, numSelected],
  );
  const isMoonraker = numSelected === 1 && !!primaryPrinter?.moonraker_url;
  const usedSlots = useMemo(() => usedSlotIndices(selectedFile?.filament_meta ?? null), [selectedFile]);

  const sendablePrinters = useMemo(
    () => printers.filter((p) => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id))),
    [printers],
  );

  const compatiblePrinters = useMemo(() => {
    const meta = selectedFile?.filament_meta;
    if (!meta?.print_size_x && !meta?.print_size_y && !meta?.print_size_z) return sendablePrinters;
    return sendablePrinters.filter((p) => fitCheck(meta, p) !== "oversize");
  }, [sendablePrinters, selectedFile]);

  const printerGroups = useMemo(() => {
    const groups = new Map<string, Printer[]>();
    for (const p of compatiblePrinters) {
      const key = p.group_name ?? "Принтери";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return groups;
  }, [compatiblePrinters]);

  useEffect(() => {
    setLoadingFiles(true);
    Promise.all([api<GcodeFile[]>("/api/files"), api<GcodeFolder[]>("/api/folders")])
      .then(([files, fols]) => { setAllFiles(files); setFolders(fols); })
      .finally(() => setLoadingFiles(false));
  }, []);

  // Auto-map slots when primary printer or file changes
  useEffect(() => {
    if (!selectedFile || !primaryPrinter) return;
    setSlotMap(autoMapSlots(selectedFile.filament_meta, primaryPrinter));
    setCalibrateSlots(new Set(usedSlotIndices(selectedFile.filament_meta)));
  }, [selectedFile?.id, primaryPrinter?.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  function pickFile(f: GcodeFile) {
    setSelectedFile(f);
    setResult(null);
    setMultiResults(null);
    setStep("configure");
  }

  function togglePrinter(p: Printer) {
    if (multiResults) { setMultiResults(null); setResult(null); }
    setSelectedPrinterIds((prev) => {
      const n = new Set(prev);
      if (n.has(p.id)) n.delete(p.id); else n.add(p.id);
      return n;
    });
  }

  async function send() {
    if (!selectedFile || numSelected === 0 || busy) return;
    setBusy(true);
    setResult(null);
    setMultiResults(null);

    const targets = printers.filter((p) => selectedPrinterIds.has(p.id));

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
        const res = await api<{ ok: boolean; message: string }>(
          `/api/files/${selectedFile.id}/send/${p.id}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        setResult({ ok: res.ok, message: res.message });
      } catch (e) {
        setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
      }
    } else {
      const settled = await Promise.allSettled(
        targets.map(async (p) => {
          const sm = autoMapSlots(selectedFile.filament_meta, p);
          const apiSlotMap: Record<number, number> = {};
          for (const i of usedSlotIndices(selectedFile.filament_meta)) {
            if ((sm[i] ?? i) !== i) apiSlotMap[i] = sm[i];
          }
          const res = await api<{ ok: boolean; message: string }>(
            `/api/files/${selectedFile.id}/send/${p.id}`,
            { method: "POST", body: JSON.stringify({ slot_map: apiSlotMap }) },
          );
          return { printerId: p.id, name: p.name, ok: res.ok, message: res.message };
        }),
      );
      setMultiResults(
        settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : { printerId: targets[i].id, name: targets[i].name, ok: false, message: r.reason instanceof ApiError ? r.reason.message : "Помилка" },
        ),
      );
    }
    setBusy(false);
  }

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const visibleFolders = search || currentFolderId !== null ? [] : folders;
  const visibleFiles = search
    ? allFiles.filter((f) => f.original_name.toLowerCase().includes(search.toLowerCase()))
    : allFiles.filter((f) => f.folder_id === currentFolderId);

  const allDone = result?.ok || (!!multiResults && multiResults.every((r) => r.ok));
  const canSend = numSelected > 0 && !!selectedFile && !busy && !allDone;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`flex w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl ${
          step === "configure" ? "max-w-5xl" : "max-w-lg"
        }`}
        style={{ height: step === "configure" ? "82vh" : undefined, maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          {step === "configure" && (
            <button
              onClick={() => { setStep("file"); setResult(null); setMultiResults(null); }}
              className="flex size-7 items-center justify-center rounded-lg text-sm text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
            >
              ←
            </button>
          )}
          <div className="min-w-0 flex-1 px-1">
            <h2 className="text-sm font-semibold leading-none">
              {step === "file" ? "Вибери файл" : "Запуск друку"}
            </h2>
            {step === "configure" && numSelected > 0 && (
              <p className="mt-0.5 text-[11px] text-[var(--accent)]">
                {numSelected === 1 ? primaryPrinter?.name : `Вибрано: ${numSelected} принтери`}
              </p>
            )}
          </div>
          <div className="mr-1 flex items-center gap-1">
            {(["file", "configure"] as const).map((s) => (
              <span key={s} className={`h-1 rounded-full transition-all ${s === step ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--border)]"}`} />
            ))}
          </div>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* ── File picker ── */}
        {step === "file" && (
          <>
            <div className="border-b border-[var(--border)] px-4 py-2.5">
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
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
                        <button
                          key={folder.id}
                          onClick={() => { setCurrentFolderId(folder.id); setSearch(""); }}
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
                      {allFiles.length === 0 ? "Файлів ще немає" : search ? "Нічого не знайдено" : "Папка порожня"}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {visibleFiles.map((f) => (
                        <button
                          key={f.id} onClick={() => pickFile(f)}
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
        )}

        {/* ── Configure step: LEFT settings + RIGHT printer grid ── */}
        {step === "configure" && (
          <div className="flex flex-1 overflow-hidden">

            {/* LEFT: settings panel */}
            <div className="flex w-72 shrink-0 flex-col border-r border-[var(--border)]">
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">

                {/* File summary */}
                {selectedFile && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] text-[9px] font-mono text-[var(--text-muted)]">
                      {selectedFile.has_thumbnail
                        ? <img src={`${API_URL}/api/files/${selectedFile.id}/thumbnail`} alt="" className="h-full w-full object-cover" />
                        : selectedFile.original_name.split(".").pop()!.toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{selectedFile.original_name}</p>
                      <div className="mt-0.5 flex items-center gap-2">
                        {selectedFile.filament_meta?.estimated_minutes && (
                          <span className="text-[10px] text-[var(--text-faint)]">~{fmtMinutes(selectedFile.filament_meta.estimated_minutes)}</span>
                        )}
                        {selectedFile.filament_meta?.colors && selectedFile.filament_meta.colors.length > 0 && (
                          <span className="flex gap-0.5">
                            {selectedFile.filament_meta.colors.slice(0, 5).map((c, ci) => (
                              <span key={ci} className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: c ?? "#ccc" }} />
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Printer selection hint */}
                {numSelected === 0 && (
                  <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-6 text-center">
                    <p className="text-xs text-[var(--text-faint)]">Вибери принтер →</p>
                  </div>
                )}

                {/* Multi-select info */}
                {numSelected > 1 && (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
                    <p className="text-[11px] font-medium text-[var(--text-muted)]">Авто-маппінг · {numSelected} принтери</p>
                    <p className="mt-1 text-[10px] text-[var(--text-faint)]">
                      Кожен принтер отримає автоматично підібрані слоти за кольором та типом матеріалу.
                    </p>
                  </div>
                )}

                {/* Slot mapping (single printer) */}
                {numSelected === 1 && usedSlots.length > 0 && primaryPrinter && (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
                    <div className="mb-2.5 flex items-center justify-between">
                      <p className="text-[11px] font-medium text-[var(--text-muted)]">Маппінг котушок</p>
                      <button
                        onClick={() => setSlotMap(autoMapSlots(selectedFile!.filament_meta, primaryPrinter))}
                        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)]"
                      >
                        Авто
                      </button>
                    </div>
                    <div className="space-y-3">
                      {usedSlots.map((i) => {
                        const fileColor = selectedFile!.filament_meta?.colors?.[i] ?? null;
                        const fileType  = selectedFile!.filament_meta?.types?.[i] ?? null;
                        const grams     = selectedFile!.filament_meta?.used_g?.[i];
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
                                    <button
                                      key={s.slot} type="button"
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
                              <select
                                value={currentTarget}
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

                {/* Moonraker options (single Moonraker printer) */}
                {isMoonraker && (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
                    <p className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">Опції</p>
                    <div className="space-y-1.5">
                      {([
                        [autoBedLeveling, setAutoBedLeveling, "Автокалібрування"] as const,
                        [timelapse,       setTimelapse,       "Таймлапс"] as const,
                        [aiDetection,     setAiDetection,     "AI детекція"] as const,
                      ] as const).map(([checked, setter, label]) => (
                        <label key={label} className="flex cursor-pointer items-center gap-2 text-[11px]">
                          <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} className="accent-neutral-900 dark:accent-white" />
                          <span className="text-[var(--text)]">{label}</span>
                        </label>
                      ))}
                    </div>
                    {usedSlots.length > 0 && (
                      <>
                        <p className="mb-1.5 mt-3 text-[11px] font-medium text-[var(--text-muted)]">Калібрувати</p>
                        <div className="space-y-1">
                          {usedSlots.map((i) => {
                            const fileColor = selectedFile!.filament_meta?.colors?.[i] ?? null;
                            const fileType  = selectedFile!.filament_meta?.types?.[i] ?? null;
                            return (
                              <label key={i} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                                <input type="checkbox" checked={calibrateSlots.has(i)}
                                  onChange={() => setCalibrateSlots((prev) => {
                                    const n = new Set(prev);
                                    if (n.has(i)) n.delete(i); else n.add(i);
                                    return n;
                                  })}
                                  className="accent-neutral-900 dark:accent-white"
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

                {/* Single result banner */}
                {result && (
                  <div className={[
                    "rounded-xl px-3 py-2.5 text-xs",
                    result.ok
                      ? "border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                      : "border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",
                  ].join(" ")}>
                    {result.ok ? "✓ " : "✕ "}{result.message}
                  </div>
                )}
              </div>

              {/* Action buttons pinned at bottom */}
              <div className="shrink-0 space-y-2 border-t border-[var(--border)] px-4 py-3">
                {!allDone && (
                  <button
                    onClick={send}
                    disabled={!canSend}
                    className="btn btn-primary w-full disabled:opacity-40"
                  >
                    {busy
                      ? "Надсилаю…"
                      : numSelected === 0
                        ? "Вибери принтер"
                        : numSelected === 1
                          ? `▶ ${primaryPrinter?.name ?? "Надіслати"}`
                          : `▶ Надіслати на ${numSelected}`}
                  </button>
                )}
                <button onClick={onClose} className="btn btn-ghost w-full">
                  {allDone ? "Закрити" : "Скасувати"}
                </button>
              </div>
            </div>

            {/* RIGHT: printer grid */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {compatiblePrinters.length === 0 ? (
                <p className="py-12 text-center text-sm text-[var(--text-faint)]">Немає доступних принтерів</p>
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
                          const slots  = selectedFile ? checkSlots(selectedFile.filament_meta, p) : [];
                          const compat = selectedFile ? compatBadge(slots) : null;
                          const fit    = selectedFile ? fitCheck(selectedFile.filament_meta, p) : "unknown";
                          const nozzle = selectedFile ? nozzleCheck(selectedFile.filament_meta, p) : "unknown";
                          const model  = selectedFile ? modelCheck(selectedFile.filament_meta, p, selectedFile.original_name) : "unknown";
                          const matSlots  = printerMaterialSlots(p);
                          const isSelected = selectedPrinterIds.has(p.id);
                          const cover  = printerCover(p);
                          const res    = multiResults?.find((r) => r.printerId === p.id);
                          const isOffline = p.state === "offline" || p.state === "unknown";

                          return (
                            <button
                              key={p.id}
                              onClick={() => togglePrinter(p)}
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
                                  <img
                                    src={cover}
                                    alt={p.name}
                                    className="h-full w-full object-contain p-4 transition-transform group-hover:scale-105"
                                    style={{ opacity: isOffline ? 0.45 : 1, filter: isOffline ? "grayscale(0.7)" : undefined }}
                                  />
                                ) : (
                                  <div className="flex h-full items-center justify-center">
                                    <span className="text-5xl font-black text-[var(--border-strong)]">
                                      {p.name.charAt(0).toUpperCase()}
                                    </span>
                                  </div>
                                )}

                                {/* State pill */}
                                <span className={[
                                  "absolute left-2 top-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur-sm",
                                  p.state === "idle" || p.state === "operational"
                                    ? "bg-[rgba(34,197,94,.18)] text-[var(--state-ok)]"
                                    : p.state === "printing"
                                      ? "bg-[rgba(59,130,246,.18)] text-[var(--state-print)]"
                                      : p.state === "error"
                                        ? "bg-[rgba(239,68,68,.18)] text-[var(--state-error)]"
                                        : "bg-black/25 text-white/70",
                                ].join(" ")}>
                                  <span className={`h-1.5 w-1.5 rounded-full ${stateDot(p)}`} />
                                  {stateLabel(p)}
                                </span>

                                {/* Checkbox */}
                                <span className={[
                                  "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded border-2 shadow transition-all",
                                  isSelected
                                    ? "border-[var(--accent)] bg-[var(--accent)] text-white shadow-[var(--accent)]/30"
                                    : "border-white/50 bg-black/25",
                                ].join(" ")}>
                                  {isSelected && <Check size={10} strokeWidth={3.5} />}
                                </span>

                                {/* Result overlay */}
                                {res && (
                                  <div className={[
                                    "absolute inset-0 flex items-center justify-center text-2xl font-black",
                                    res.ok ? "bg-[rgba(34,197,94,.3)]" : "bg-[rgba(239,68,68,.3)]",
                                  ].join(" ")}>
                                    <span>{res.ok ? "✓" : "✕"}</span>
                                  </div>
                                )}
                              </div>

                              {/* Info */}
                              <div className={`flex flex-col gap-1.5 p-3 ${isSelected ? "bg-[var(--surface-hi)]" : "bg-[var(--bg-elevated)]"}`}>
                                <p className="truncate text-sm font-semibold">{p.name}</p>
                                {(p.build_x || p.nozzle_diameter) && (
                                  <p className="text-[10px] text-[var(--text-faint)]">
                                    {p.build_x && p.build_y ? `${p.build_x}×${p.build_y}мм` : ""}
                                    {p.nozzle_diameter ? ` · ∅${p.nozzle_diameter}мм` : ""}
                                  </p>
                                )}
                                {matSlots.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {matSlots.slice(0, 4).map((s) => (
                                      <span key={s.slot} className="flex items-center gap-0.5 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                                        {s.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />}
                                        {s.type ?? slotLabel(s.slot)}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-1 empty:hidden">
                                  {fit === "oversize"    && <span className="badge badge-error text-[9px]">✕ не влазить</span>}
                                  {nozzle === "mismatch" && <span className="badge badge-warn text-[9px]">∅≠</span>}
                                  {model === "mismatch"  && <span className="badge badge-warn text-[9px]">⚠ модель</span>}
                                  {compat && <span className={`${compat.cls} text-[9px]`}>{compat.label}</span>}
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
      </div>
    </div>
  );
}
