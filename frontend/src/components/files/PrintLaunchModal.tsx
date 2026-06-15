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

type Step = "file" | "printer" | "launch";

function stateColor(p: Printer) {
  switch (p.state) {
    case "idle": case "operational": return "bg-[var(--state-ok)]";
    case "printing": return "bg-[var(--state-warn)]";
    case "error": return "bg-[var(--state-error)]";
    default: return "bg-[var(--state-offline)]";
  }
}

export function PrintLaunchModal({
  printers,
  defaultPrinterId,
  onClose,
}: {
  printers: Printer[];
  defaultPrinterId?: number;
  onClose: () => void;
}) {
  const [stepHistory, setStepHistory] = useState<Step[]>(["file"]);
  const step = stepHistory[stepHistory.length - 1];

  const [selectedFile, setSelectedFile] = useState<GcodeFile | null>(null);
  const [selectedPrinterIds, setSelectedPrinterIds] = useState<Set<number>>(
    defaultPrinterId ? new Set([defaultPrinterId]) : new Set(),
  );

  const [allFiles, setAllFiles] = useState<GcodeFile[]>([]);
  const [folders, setFolders] = useState<GcodeFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [search, setSearch] = useState("");

  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [multiResults, setMultiResults] = useState<{ name: string; ok: boolean; message: string }[] | null>(null);

  const selectedPrinter = useMemo(
    () => (selectedPrinterIds.size === 1 ? printers.find((p) => selectedPrinterIds.has(p.id)) ?? null : null),
    [printers, selectedPrinterIds],
  );
  const isMoonraker = !!selectedPrinter?.moonraker_url;
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

  useEffect(() => {
    if (!selectedFile || !selectedPrinter) return;
    setSlotMap(autoMapSlots(selectedFile.filament_meta, selectedPrinter));
    setCalibrateSlots(new Set(usedSlotIndices(selectedFile.filament_meta)));
  }, [selectedFile?.id, selectedPrinter?.id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  function goTo(s: Step) { setStepHistory((prev) => [...prev, s]); }
  function goBack() { setStepHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)); }

  function pickFile(f: GcodeFile) {
    setSelectedFile(f);
    setResult(null);
    setMultiResults(null);
    goTo(defaultPrinterId ? "launch" : "printer");
  }

  function togglePrinter(p: Printer) {
    setMultiResults(null);
    setSelectedPrinterIds((prev) => {
      const n = new Set(prev);
      if (n.has(p.id)) n.delete(p.id); else n.add(p.id);
      return n;
    });
  }

  async function sendPrint() {
    if (!selectedFile || !selectedPrinter) return;
    setBusy(true);
    setResult(null);
    try {
      const apiSlotMap: Record<number, number> = {};
      for (const i of usedSlots) {
        const mapped = slotMap[i] ?? i;
        if (mapped !== i) apiSlotMap[i] = mapped;
      }
      const body: Record<string, unknown> = { slot_map: apiSlotMap };
      if (isMoonraker) {
        if (!autoBedLeveling) body.auto_bed_leveling = false;
        if (!timelapse) body.timelapse = false;
        if (!aiDetection) body.ai_detection = false;
        if (calibrateSlots.size !== usedSlots.length)
          body.calibrate_slots = Array.from(calibrateSlots).sort((a, b) => a - b);
      }
      const res = await api<{ ok: boolean; printer_name: string; message: string }>(
        `/api/files/${selectedFile.id}/send/${selectedPrinter.id}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult({ ok: res.ok, message: res.message });
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally {
      setBusy(false);
    }
  }

  async function sendToMultiple() {
    if (!selectedFile || selectedPrinterIds.size < 2) return;
    setBusy(true);
    setMultiResults(null);
    const targets = printers.filter((p) => selectedPrinterIds.has(p.id));
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
        return { name: p.name, ok: res.ok, message: res.message };
      }),
    );
    setMultiResults(
      settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : { name: targets[i].name, ok: false, message: r.reason instanceof ApiError ? r.reason.message : "Помилка" },
      ),
    );
    setBusy(false);
  }

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const visibleFolders = search || currentFolderId !== null ? [] : folders;
  const visibleFiles = search
    ? allFiles.filter((f) => f.original_name.toLowerCase().includes(search.toLowerCase()))
    : allFiles.filter((f) => f.folder_id === currentFolderId);

  const numSelected = selectedPrinterIds.size;
  const allDone = multiResults?.every((r) => r.ok) ?? false;
  const modalWidth = step === "printer" ? "max-w-3xl" : "max-w-lg";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={`flex w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl ${modalWidth}`}
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          {stepHistory.length > 1 && (
            <button
              onClick={goBack}
              className="flex size-7 items-center justify-center rounded-lg text-sm text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
            >
              ←
            </button>
          )}
          <div className="min-w-0 flex-1 px-1">
            <h2 className="text-sm font-semibold leading-none">
              {step === "file" && "Вибери файл"}
              {step === "printer" && (selectedFile ? `Принтер · ${selectedFile.original_name}` : "Вибери принтер")}
              {step === "launch" && "Запуск друку"}
            </h2>
            {step === "file" && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
                <button onClick={() => { setCurrentFolderId(null); setSearch(""); }} className="transition hover:text-[var(--text)]">
                  Всі файли
                </button>
                {currentFolder && (
                  <>
                    <ChevronRight size={9} className="shrink-0" />
                    <span>{currentFolder.name}</span>
                  </>
                )}
              </div>
            )}
            {step === "printer" && numSelected > 0 && (
              <p className="mt-0.5 text-[11px] text-[var(--accent)]">Вибрано: {numSelected}</p>
            )}
          </div>
          <div className="mr-1 flex items-center gap-1">
            {(["file", "printer", "launch"] as const).map((s) => (
              <span
                key={s}
                className={`h-1 rounded-full transition-all ${s === step ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--border)]"}`}
              />
            ))}
          </div>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[var(--text-faint)] transition hover:bg-[var(--surface-hi)] hover:text-[var(--text)]"
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

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
              <div className="px-4 py-3">
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

          {/* ── Printer picker (multi-select) ── */}
          {step === "printer" && (
            <div className="space-y-5 px-5 py-4">
              {compatiblePrinters.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--text-faint)]">Немає доступних принтерів</p>
              ) : (
                <>
                  <p className="text-xs text-[var(--text-faint)]">Клікни щоб вибрати один або кілька принтерів</p>
                  {[...printerGroups.entries()].map(([groupName, groupPrinters]) => (
                    <div key={groupName}>
                      {printerGroups.size > 1 && (
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{groupName}</p>
                      )}
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {groupPrinters.map((p) => {
                          const slots = selectedFile ? checkSlots(selectedFile.filament_meta, p) : [];
                          const compat = selectedFile ? compatBadge(slots) : null;
                          const fit = selectedFile ? fitCheck(selectedFile.filament_meta, p) : "unknown";
                          const nozzle = selectedFile ? nozzleCheck(selectedFile.filament_meta, p) : "unknown";
                          const model = selectedFile ? modelCheck(selectedFile.filament_meta, p, selectedFile.original_name) : "unknown";
                          const matSlots = printerMaterialSlots(p);
                          const isSelected = selectedPrinterIds.has(p.id);
                          const res = multiResults?.find((r) => r.name === p.name);
                          return (
                            <button
                              key={p.id} onClick={() => togglePrinter(p)}
                              className={[
                                "relative flex flex-col gap-2.5 rounded-xl border p-3 text-left transition hover:shadow-sm",
                                isSelected
                                  ? "border-[var(--accent)] bg-[rgba(var(--accent-rgb),.06)]"
                                  : "border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hi)]",
                              ].join(" ")}
                            >
                              {/* Checkbox */}
                              <span className={[
                                "absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded border transition-all",
                                isSelected
                                  ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                                  : "border-[var(--border-strong)]",
                              ].join(" ")}>
                                {isSelected && <Check size={9} strokeWidth={3} />}
                              </span>
                              <div className="flex items-center gap-2 pr-6">
                                <span className={`h-2 w-2 shrink-0 rounded-full ${stateColor(p)}`} />
                                <p className="flex-1 truncate text-sm font-medium">{p.name}</p>
                              </div>
                              {(p.build_x || p.nozzle_diameter) && (
                                <p className="text-[10px] text-[var(--text-faint)]">
                                  {p.build_x && p.build_y ? `${p.build_x}×${p.build_y}` : ""}
                                  {p.nozzle_diameter ? ` ∅${p.nozzle_diameter}мм` : ""}
                                </p>
                              )}
                              {matSlots.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {matSlots.map((s) => (
                                    <span key={s.slot} className="flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                                      {s.color && <span className="h-2 w-2 shrink-0 rounded-full border border-black/10" style={{ background: s.color }} />}
                                      {s.type ?? slotLabel(s.slot)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-1 empty:hidden">
                                {fit === "oversize" && <span className="badge badge-error text-[9px]">✕ не влазить</span>}
                                {nozzle === "mismatch" && <span className="badge badge-warn text-[9px]">∅≠</span>}
                                {model === "mismatch" && <span className="badge badge-warn text-[9px]">⚠ модель</span>}
                                {compat && <span className={`${compat.cls} text-[9px]`}>{compat.label}</span>}
                              </div>
                              {res && (
                                <div className={[
                                  "rounded-lg px-2 py-1 text-[10px] font-medium",
                                  res.ok
                                    ? "bg-[rgba(34,197,94,.1)] text-[var(--state-ok)]"
                                    : "bg-[rgba(239,68,68,.1)] text-[var(--state-error)]",
                                ].join(" ")}>
                                  {res.ok ? "✓" : "✕"} {res.message}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── Launch (single printer) ── */}
          {step === "launch" && selectedFile && selectedPrinter && (
            <div className="space-y-4 px-5 py-4">
              <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] text-[9px] font-mono text-[var(--text-muted)]">
                  {selectedFile.has_thumbnail
                    ? <img src={`${API_URL}/api/files/${selectedFile.id}/thumbnail`} alt="" className="h-full w-full object-cover" />
                    : selectedFile.original_name.split(".").pop()!.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{selectedFile.original_name}</p>
                  {selectedFile.filament_meta && (
                    <p className="text-[10px] text-[var(--text-faint)]">
                      {selectedFile.filament_meta.estimated_minutes && `~${fmtMinutes(selectedFile.filament_meta.estimated_minutes)}`}
                      {selectedFile.filament_meta.total_layers && ` · ${selectedFile.filament_meta.total_layers} шарів`}
                    </p>
                  )}
                </div>
                <span className="mx-1 text-[var(--text-faint)]">→</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${stateColor(selectedPrinter)}`} />
                  <span className="text-sm font-medium">{selectedPrinter.name}</span>
                </div>
              </div>

              {usedSlots.length > 0 && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs font-medium text-[var(--text-muted)]">Маппінг котушок</p>
                    <button
                      onClick={() => setSlotMap(autoMapSlots(selectedFile.filament_meta, selectedPrinter))}
                      className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition hover:bg-[var(--surface-hi)]"
                    >
                      Авто
                    </button>
                  </div>
                  <div className="space-y-3">
                    {usedSlots.map((i) => {
                      const fileColor = selectedFile.filament_meta?.colors?.[i] ?? null;
                      const fileType = selectedFile.filament_meta?.types?.[i] ?? null;
                      const grams = selectedFile.filament_meta?.used_g?.[i];
                      const matSlots = printerMaterialSlots(selectedPrinter);
                      const currentTarget = slotMap[i] ?? i;
                      return (
                        <div key={i} className="flex items-start gap-3">
                          <div className="flex w-28 shrink-0 items-center gap-1.5 pt-0.5">
                            {fileColor && (
                              <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white/20 shadow-sm" style={{ background: fileColor }} />
                            )}
                            <span className="truncate text-xs">
                              Слот {i + 1}{fileType ? ` · ${fileType}` : ""}{grams != null ? ` · ${grams}г` : ""}
                            </span>
                          </div>
                          <span className="shrink-0 pt-0.5 text-sm text-[var(--text-faint)]">→</span>
                          {matSlots.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {matSlots.map((s) => {
                                const isSel = currentTarget === s.slot;
                                return (
                                  <button
                                    key={s.slot} type="button"
                                    onClick={() => setSlotMap((prev) => ({ ...prev, [i]: s.slot }))}
                                    title={`${slotLabel(s.slot)}${s.type ? ` · ${s.type}` : ""}${s.colorName ? ` · ${s.colorName}` : ""}`}
                                    className={[
                                      "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition",
                                      isSel
                                        ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                                    ].join(" ")}
                                  >
                                    {s.color && (
                                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/20" style={{ background: s.color }} />
                                    )}
                                    {slotLabel(s.slot)}{s.type ? ` · ${s.type}` : ""}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <select
                              value={currentTarget}
                              onChange={(e) => setSlotMap((prev) => ({ ...prev, [i]: Number(e.target.value) }))}
                              className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs outline-none"
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

              {isMoonraker && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                  <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Опції</p>
                  <div className="space-y-1.5">
                    {([
                      [autoBedLeveling, setAutoBedLeveling, "Автокалібрування столу"] as const,
                      [timelapse, setTimelapse, "Таймлапс"] as const,
                      [aiDetection, setAiDetection, "AI детекція"] as const,
                    ] as const).map(([checked, setter, label]) => (
                      <label key={label} className="flex cursor-pointer items-center gap-2 text-xs">
                        <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} className="accent-neutral-900 dark:accent-white" />
                        <span className="text-[var(--text)]">{label}</span>
                      </label>
                    ))}
                  </div>
                  {usedSlots.length > 0 && (
                    <>
                      <p className="mb-1.5 mt-3 text-xs font-medium text-[var(--text-muted)]">Калібрувати філамент</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {usedSlots.map((i) => {
                          const fileColor = selectedFile.filament_meta?.colors?.[i] ?? null;
                          const fileType = selectedFile.filament_meta?.types?.[i] ?? null;
                          return (
                            <label key={i} className="flex cursor-pointer items-center gap-1.5 text-xs">
                              <input type="checkbox" checked={calibrateSlots.has(i)}
                                onChange={() => setCalibrateSlots((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(i)) n.delete(i); else n.add(i);
                                  return n;
                                })}
                                className="accent-neutral-900 dark:accent-white"
                              />
                              {fileColor && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                              <span className="truncate text-[var(--text)]">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}

              {result && (
                <div className={["rounded-xl px-4 py-3 text-sm",
                  result.ok
                    ? "border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                    : "border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",
                ].join(" ")}>
                  {result.ok ? "✓ " : "✕ "}{result.message}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button onClick={onClose} className="btn btn-ghost">
            {result?.ok || allDone ? "Закрити" : "Скасувати"}
          </button>

          {step === "printer" && numSelected > 0 && !multiResults && (
            numSelected === 1 ? (
              <button onClick={() => goTo("launch")} className="btn btn-primary">
                Далі →
              </button>
            ) : (
              <button
                onClick={sendToMultiple}
                disabled={busy}
                className="btn btn-primary disabled:opacity-40"
              >
                {busy ? "Надсилаю…" : `▶ Надіслати на ${numSelected}`}
              </button>
            )
          )}

          {step === "launch" && !result?.ok && (
            <button
              onClick={sendPrint}
              disabled={busy || !selectedFile || !selectedPrinter}
              className="btn btn-primary disabled:opacity-40"
            >
              {busy ? "Надсилаю…" : `▶ ${selectedPrinter?.name ?? "Надіслати"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
