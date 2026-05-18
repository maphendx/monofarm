"use client";

import { useMemo, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { GcodeFile, GcodeFileMeta, Printer } from "@/lib/types";

// ── helpers (shared with StartPrintModal) ─────────────────────────────────────

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

export function checkSlots(meta: GcodeFileMeta | null, printer: Printer) {
  if (!meta) return [];
  return usedSlotIndices(meta).map((i) => {
    const fileColor = meta.colors?.[i] ?? null;
    const fileType = meta.types?.[i] ?? null;
    const printerSlot = printer.loaded_filaments.find((s) => s.slot === i);
    const printerColor = printerSlot?.color ?? null;
    const printerType = printerSlot?.type ?? null;
    let match: SlotMatch = "missing";
    if (printerSlot) {
      const typeOk = !fileType || !printerType || fileType.toLowerCase() === printerType.toLowerCase();
      match = typeOk ? "ok" : "type_mismatch";
    }
    return { slot: i + 1, fileColor, fileType, match, printerColor, printerType };
  });
}

export function compatBadge(slots: ReturnType<typeof checkSlots>) {
  if (slots.length === 0) return { label: "немає даних", cls: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800" };
  const missing = slots.filter((s) => s.match === "missing").length;
  const mismatch = slots.filter((s) => s.match === "type_mismatch").length;
  if (missing === 0 && mismatch === 0) return { label: "сумісний ✓", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" };
  if (missing > 0) return { label: `${missing} слот${missing > 1 ? "и" : ""} відсутні`, cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" };
  return { label: `тип не збігається (${mismatch})`, cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
}

function SlotSwatches({ meta }: { meta: GcodeFileMeta }) {
  const indices = usedSlotIndices(meta);
  if (indices.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {indices.map((i) => {
        const color = meta.colors?.[i] ?? null;
        const type = meta.types?.[i] ?? null;
        const grams = meta.used_g?.[i];
        return (
          <div key={i} title={`Слот ${i + 1}`}
            className="flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
            {color && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: color }} />}
            <span>Слот {i + 1}{type ? ` · ${type}` : ""}{grams != null ? ` · ${grams}г` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── SendModal ─────────────────────────────────────────────────────────────────

export function SendModal({
  file,
  printers,
  onClose,
  defaultPrinterId,
}: {
  file: GcodeFile;
  printers: Printer[];
  onClose: () => void;
  defaultPrinterId?: number;
}) {
  const [selectedId, setSelectedId] = useState<number | "">(defaultPrinterId ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());

  const sendablePrinters = printers.filter(
    (p) => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)),
  );
  const selectedPrinter = sendablePrinters.find((p) => p.id === selectedId) ?? null;
  const usedSlots = useMemo(() => usedSlotIndices(file.filament_meta), [file.filament_meta]);
  const isMoonraker = !!selectedPrinter?.moonraker_url;

  function selectPrinter(id: number) {
    setSelectedId(id);
    setResult(null);
    const identity: Record<number, number> = {};
    for (const i of usedSlots) identity[i] = i;
    setSlotMap(identity);
    setCalibrateSlots(new Set(usedSlots));
  }

  async function send() {
    if (!selectedId) return;
    setBusy(true);
    setResult(null);
    try {
      const apiSlotMap: Record<number, number> = {};
      for (const i of usedSlots) apiSlotMap[i] = slotMap[i] ?? i;
      const body: Record<string, unknown> = { slot_map: apiSlotMap };
      if (isMoonraker) {
        if (!autoBedLeveling) body.auto_bed_leveling = false;
        if (!timelapse) body.timelapse = false;
        if (!aiDetection) body.ai_detection = false;
        if (calibrateSlots.size !== usedSlots.length)
          body.calibrate_slots = Array.from(calibrateSlots).sort((a, b) => a - b);
      }
      const res = await api<{ ok: boolean; printer_name: string; message: string }>(
        `/api/files/${file.id}/send/${selectedId}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setResult({ ok: res.ok, message: res.message });
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold">Надіслати на принтер</h2>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{file.original_name}</p>
        </div>

        {file.filament_meta && (
          <div className="border-b border-neutral-100 px-5 pb-4 dark:border-neutral-800">
            <p className="mb-1.5 text-xs font-medium text-neutral-500">Потрібні матеріали</p>
            <SlotSwatches meta={file.filament_meta} />
            {file.filament_meta.estimated_minutes && (
              <p className="mt-1.5 text-xs text-neutral-400">
                Час: ~{fmtMinutes(file.filament_meta.estimated_minutes)}
                {file.filament_meta.layer_height && ` · шар ${file.filament_meta.layer_height} мм`}
              </p>
            )}
          </div>
        )}

        <div className="space-y-4 px-5 py-4">
          {sendablePrinters.length === 0 ? (
            <p className="text-sm text-neutral-500">Немає доступних принтерів</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 max-h-80 overflow-y-auto pr-1">
              {sendablePrinters.map((p) => {
                const slots = checkSlots(file.filament_meta, p);
                const compat = compatBadge(slots);
                return (
                  <label key={p.id} className={[
                    "flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition",
                    selectedId === p.id
                      ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-800"
                      : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500",
                  ].join(" ")}>
                    <div className="flex items-center gap-3">
                      <input type="radio" name="printer" value={p.id}
                        checked={selectedId === p.id} onChange={() => selectPrinter(p.id)}
                        className="accent-neutral-900 dark:accent-white" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                      </div>
                      <span className={[
                        "shrink-0 rounded px-1.5 py-0.5 text-xs",
                        p.state === "printing" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                          : p.state === "idle" || p.state === "operational" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800",
                      ].join(" ")}>{p.state ?? "—"}</span>
                    </div>
                    {slots.length > 0 && (
                      <div className="ml-6 flex flex-wrap gap-1">
                        {slots.map((s) => (
                          <div key={s.slot} className={[
                            "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                            s.match === "ok" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                              : s.match === "type_mismatch" ? "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                              : "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400",
                          ].join(" ")}>
                            {s.fileColor && <span className="h-2 w-2 shrink-0 rounded-full border border-black/10" style={{ background: s.fileColor }} />}
                            {s.match === "ok" ? "✓" : s.match === "type_mismatch" ? "~" : "✕"} Слот {s.slot}
                            {s.match === "type_mismatch" && s.printerType && ` (є ${s.printerType})`}
                          </div>
                        ))}
                        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${compat.cls}`}>{compat.label}</span>
                      </div>
                    )}
                    {slots.length === 0 && p.loaded_filaments.length > 0 && (
                      <div className="ml-6 flex flex-wrap gap-1">
                        {p.loaded_filaments.map((lf) => (
                          <div key={lf.slot} className="flex items-center gap-1 rounded-full border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:border-neutral-700">
                            <span className="h-2 w-2 shrink-0 rounded-full border border-black/10" style={{ background: lf.color }} />
                            {lf.type}
                          </div>
                        ))}
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {selectedPrinter && usedSlots.length > 0 && !result && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Ремаппінг слотів</p>
              <div className="space-y-2">
                {usedSlots.map((i) => {
                  const fileColor = file.filament_meta?.colors?.[i] ?? null;
                  const fileType = file.filament_meta?.types?.[i] ?? null;
                  const currentPrinterSlot = slotMap[i] ?? i;
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {fileColor && <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                        <span className="truncate text-neutral-700 dark:text-neutral-300">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                      </div>
                      <span className="text-neutral-400">→</span>
                      <select value={currentPrinterSlot}
                        onChange={(e) => setSlotMap((prev) => ({ ...prev, [i]: Number(e.target.value) }))}
                        className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900">
                        {selectedPrinter.loaded_filaments.length > 0
                          ? selectedPrinter.loaded_filaments.map((lf) => (
                              <option key={lf.slot} value={lf.slot}>
                                Слот {lf.slot + 1}{lf.type ? ` · ${lf.type}` : ""}{lf.color_name ? ` · ${lf.color_name}` : ""}
                              </option>
                            ))
                          : Array.from({ length: 4 }).map((_, s) => (
                              <option key={s} value={s}>Слот {s + 1}</option>
                            ))}
                      </select>
                      {(() => {
                        const lf = selectedPrinter.loaded_filaments.find((f) => f.slot === currentPrinterSlot);
                        return lf?.color ? (
                          <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: lf.color }} title={lf.color_name ?? lf.color} />
                        ) : null;
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedPrinter && isMoonraker && !result && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Опції друку</p>
              <div className="space-y-1.5">
                {[
                  [autoBedLeveling, setAutoBedLeveling, "Автокалібрування столу"] as const,
                  [timelapse, setTimelapse, "Таймлапс"] as const,
                  [aiDetection, setAiDetection, "AI детекція"] as const,
                ].map(([checked, setter, label]) => (
                  <label key={label} className="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} className="accent-neutral-900 dark:accent-white" />
                    <span className="text-neutral-700 dark:text-neutral-300">{label}</span>
                  </label>
                ))}
              </div>
              {usedSlots.length > 0 && (
                <>
                  <p className="mt-3 mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">Калібрувати філамент у слоті</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {usedSlots.map((i) => {
                      const fileColor = file.filament_meta?.colors?.[i] ?? null;
                      const fileType = file.filament_meta?.types?.[i] ?? null;
                      return (
                        <label key={i} className="flex cursor-pointer items-center gap-1.5 text-xs">
                          <input type="checkbox" checked={calibrateSlots.has(i)} onChange={() => {
                            setCalibrateSlots((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
                          }} className="accent-neutral-900 dark:accent-white" />
                          {fileColor && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                          <span className="truncate text-neutral-700 dark:text-neutral-300">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {result && (
            <div className={["rounded-lg px-3 py-2 text-sm",
              result.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                        : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400",
            ].join(" ")}>
              {result.ok ? "✓ " : "✕ "}{result.message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <button onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            {result?.ok ? "Закрити" : "Скасувати"}
          </button>
          {!result?.ok && (
            <button onClick={send} disabled={!selectedId || busy}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
              {busy ? "Надсилаю…" : "Надіслати"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
