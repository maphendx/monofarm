"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { BambuQueuedResult, GcodeFile, GcodeFileMeta, Printer } from "@/lib/types";

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

function normalizeSlotColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const raw = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6,8}$/.test(raw)) return null;
  return `#${raw.slice(0, 6).toLowerCase()}`;
}

function printerMaterialSlots(printer: Printer) {
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

function autoMapSlots(meta: GcodeFileMeta | null, printer: Printer): Record<number, number> {
  const targets = printerMaterialSlots(printer);
  const usedTargets = new Set<number>();
  const map: Record<number, number> = {};

  for (const sourceSlot of usedSlotIndices(meta)) {
    const fileColor = normalizeSlotColor(meta?.colors?.[sourceSlot]);
    const fileType = meta?.types?.[sourceSlot]?.toLowerCase();
    const sameColor = fileColor
      ? targets.filter((t) => !usedTargets.has(t.slot) && normalizeSlotColor(t.color) === fileColor)
      : [];
    const exact = sameColor.find((t) => !fileType || !t.type || t.type.toLowerCase() === fileType) ?? sameColor[0];
    const fallback = targets.find((t) => t.slot === sourceSlot && !usedTargets.has(t.slot))
      ?? targets.find((t) => !usedTargets.has(t.slot) && fileType && t.type?.toLowerCase() === fileType);
    const picked = exact ?? fallback;
    map[sourceSlot] = picked?.slot ?? sourceSlot;
    if (picked) usedTargets.add(picked.slot);
  }

  return map;
}

export function checkSlots(meta: GcodeFileMeta | null, printer: Printer) {
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
      const typeOk = !fileType || !printerType || fileType.toLowerCase() === printerType.toLowerCase();
      match = typeOk ? "ok" : "type_mismatch";
    }
    return { slot: i + 1, targetSlot: mappedSlot + 1, fileColor, fileType, match, printerColor, printerType };
  });
}

export function compatBadge(slots: ReturnType<typeof checkSlots>) {
  if (slots.length === 0) return { label: "немає даних", cls: "bg-[var(--surface-hi)] text-[var(--text-muted)] " };
  const missing = slots.filter((s) => s.match === "missing").length;
  const mismatch = slots.filter((s) => s.match === "type_mismatch").length;
  if (missing === 0 && mismatch === 0) return { label: "сумісний ✓", cls: "badge badge-ok" };
  if (missing > 0) return { label: `${missing} слот${missing > 1 ? "и" : ""} відсутні`, cls: "badge badge-error" };
  return { label: `тип не збігається (${mismatch})`, cls: "badge badge-warn" };
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
            className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]   ">
            {color && <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10" style={{ background: color }} />}
            <span>Слот {i + 1}{type ? ` · ${type}` : ""}{grams != null ? ` · ${grams}г` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── mode tab ──────────────────────────────────────────────────────────────────

type Mode = "print" | "save" | "queue";

const MODES: { key: Mode; label: string }[] = [
  { key: "print", label: "Друкувати зараз" },
  { key: "save",  label: "Зберегти" },
  { key: "queue", label: "У чергу" },
];

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
  const [mode, setMode] = useState<Mode>("print");

  // print-now state
  const [selectedId, setSelectedId] = useState<number | "">(defaultPrinterId ?? "");
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());

  // shared result / busy
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [queuedJob, setQueuedJob] = useState<BambuQueuedResult | null>(null);

  // queue state
  const [quantity, setQuantity] = useState(1);

  const sendablePrinters = printers.filter(
    (p) => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)),
  );
  const selectedPrinter = sendablePrinters.find((p) => p.id === selectedId) ?? null;
  const usedSlots = useMemo(() => usedSlotIndices(file.filament_meta), [file.filament_meta]);
  const isMoonraker = !!selectedPrinter?.moonraker_url;

  useEffect(() => {
    if (!selectedPrinter) return;
    setSlotMap(autoMapSlots(file.filament_meta, selectedPrinter));
    setCalibrateSlots(new Set(usedSlots));
  }, [file.filament_meta, selectedPrinter?.id, usedSlots]);

  function selectPrinter(id: number) {
    setSelectedId(id);
    setResult(null);
    const printer = sendablePrinters.find((p) => p.id === id);
    setSlotMap(printer ? autoMapSlots(file.filament_meta, printer) : {});
    setCalibrateSlots(new Set(usedSlots));
  }

  function switchMode(m: Mode) {
    setMode(m);
    setResult(null);
  }

  async function sendPrint() {
    if (!selectedId) return;
    setBusy(true);
    setResult(null);
    setQueuedJob(null);
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
      const res = await api<{ ok: boolean; printer_name: string; message: string; dispatch_mode?: string; job_id?: number; printer_id?: number | null }>(
        `/api/files/${file.id}/send/${selectedId}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (res.dispatch_mode === "cloud" && res.job_id != null) {
        setQueuedJob(res as BambuQueuedResult);
        setResult({ ok: true, message: `Друк поставлено в чергу на «${res.printer_name}»` });
      } else {
        setResult({ ok: res.ok, message: res.message });
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally {
      setBusy(false);
    }
  }

  async function addToQueue() {
    setBusy(true);
    setResult(null);
    try {
      await api("/api/queue/from-library", {
        method: "POST",
        body: JSON.stringify({ gcode_file_id: file.id, quantity }),
      });
      setResult({ ok: true, message: `Додано в чергу (${quantity} шт.)` });
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "Помилка" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl  ">
        {/* header */}
        <div className="border-b border-[var(--border)] px-5 py-4 ">
          <h2 className="font-semibold">Файл завантажено</h2>
          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{file.original_name}</p>
        </div>

        {/* mode tabs */}
        <div className="flex border-b border-[var(--border)] ">
          {MODES.map((m) => (
            <button key={m.key} onClick={() => switchMode(m.key)}
              className={[
                "flex-1 py-2 text-xs font-medium transition",
                mode === m.key
                  ? "border-b-2 border-[var(--border-strong)] text-[var(--text-hi)]  "
                  : "text-[var(--text-muted)] hover:text-[var(--text)] ",
              ].join(" ")}>
              {m.label}
            </button>
          ))}
        </div>

        {/* filament meta row */}
        {file.filament_meta && (
          <div className="border-b border-[var(--border)] px-5 pb-4 pt-3 ">
            <SlotSwatches meta={file.filament_meta} />
            {file.filament_meta.estimated_minutes && (
              <p className="mt-1.5 text-xs text-[var(--text-faint)]">
                ~{fmtMinutes(file.filament_meta.estimated_minutes)}
                {file.filament_meta.layer_height && ` · шар ${file.filament_meta.layer_height} мм`}
              </p>
            )}
          </div>
        )}

        {/* body */}
        <div className="space-y-4 px-5 py-4">

          {/* ── save mode ── */}
          {mode === "save" && (
            <p className="text-sm text-[var(--text-muted)] ">
              Файл вже збережено в бібліотеці. Ви можете надіслати його на принтер пізніше.
            </p>
          )}

          {/* ── queue mode ── */}
          {mode === "queue" && !result && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-sm text-[var(--text)] ">Кількість</label>
                <div className="flex items-center gap-1">
                  <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] text-sm hover:bg-[var(--surface-hi)]  ">
                    −
                  </button>
                  <span className="w-8 text-center text-sm font-medium">{quantity}</span>
                  <button onClick={() => setQuantity((q) => q + 1)}
                    className="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-strong)] text-sm hover:bg-[var(--surface-hi)]  ">
                    +
                  </button>
                </div>
                <span className="text-xs text-[var(--text-faint)]">шт.</span>
              </div>
            </div>
          )}

          {/* ── print mode ── */}
          {mode === "print" && !result && (
            <>
              {sendablePrinters.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">Немає доступних принтерів</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto pr-1">
                  {sendablePrinters.map((p) => {
                    const slots = checkSlots(file.filament_meta, p);
                    const compat = compatBadge(slots);
                    return (
                      <label key={p.id} className={[
                        "flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition",
                        selectedId === p.id
                          ? "border-[var(--border-strong)] bg-[var(--bg)]  "
                          : "border-[var(--border)] hover:border-[var(--border-strong)] ",
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
                            p.state === "printing" ? "badge badge-warn"
                              : p.state === "idle" || p.state === "operational" ? "badge badge-ok"
                              : "badge badge-neutral",
                          ].join(" ")}>{p.state ?? "—"}</span>
                        </div>
                        {slots.length > 0 && (
                          <div className="ml-6 flex flex-wrap gap-1">
                            {slots.map((s) => (
                              <div key={s.slot} className={[
                                "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                                s.match === "ok" ? "badge badge-ok"
                                  : s.match === "type_mismatch" ? "badge badge-warn"
                                  : "badge badge-error",
                              ].join(" ")}>
                                {s.fileColor && <span className="h-2 w-2 shrink-0 rounded-full border border-black/10" style={{ background: s.fileColor }} />}
                                {s.match === "ok" ? "✓" : s.match === "type_mismatch" ? "~" : "✕"} Слот {s.slot} → {s.targetSlot}
                                {s.match === "type_mismatch" && s.printerType && ` (є ${s.printerType})`}
                              </div>
                            ))}
                            <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${compat.cls}`}>{compat.label}</span>
                          </div>
                        )}
                        {slots.length === 0 && p.loaded_filaments.length > 0 && (
                          <div className="ml-6 flex flex-wrap gap-1">
                            {p.loaded_filaments.map((lf) => (
                              <div key={lf.slot} className="flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] ">
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

              {selectedPrinter && usedSlots.length > 0 && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3  ">
                  <p className="mb-2 text-xs font-medium text-[var(--text-muted)] ">Ремаппінг слотів</p>
                  <div className="space-y-2">
                    {usedSlots.map((i) => {
                      const fileColor = file.filament_meta?.colors?.[i] ?? null;
                      const fileType = file.filament_meta?.types?.[i] ?? null;
                      const currentPrinterSlot = slotMap[i] ?? i;
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            {fileColor && <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: fileColor }} />}
                            <span className="truncate text-[var(--text)] ">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                          </div>
                          <span className="text-[var(--text-faint)]">→</span>
                          <select value={currentPrinterSlot}
                            onChange={(e) => setSlotMap((prev) => ({ ...prev, [i]: Number(e.target.value) }))}
                            className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs outline-none focus:border-[var(--border-focus)]  ">
                            {printerMaterialSlots(selectedPrinter).length > 0
                              ? printerMaterialSlots(selectedPrinter).map((lf) => (
                                  <option key={lf.slot} value={lf.slot}>
                                    Слот {lf.slot + 1}{lf.type ? ` · ${lf.type}` : ""}{lf.colorName ? ` · ${lf.colorName}` : ""}
                                  </option>
                                ))
                              : Array.from({ length: 4 }).map((_, s) => (
                                  <option key={s} value={s}>Слот {s + 1}</option>
                                ))}
                          </select>
                          {(() => {
                            const lf = printerMaterialSlots(selectedPrinter).find((f) => f.slot === currentPrinterSlot);
                            return lf?.color ? (
                              <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: lf.color }} title={lf.colorName ?? lf.color} />
                            ) : null;
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedPrinter && isMoonraker && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3  ">
                  <p className="mb-2 text-xs font-medium text-[var(--text-muted)] ">Опції друку</p>
                  <div className="space-y-1.5">
                    {[
                      [autoBedLeveling, setAutoBedLeveling, "Автокалібрування столу"] as const,
                      [timelapse, setTimelapse, "Таймлапс"] as const,
                      [aiDetection, setAiDetection, "AI детекція"] as const,
                    ].map(([checked, setter, label]) => (
                      <label key={label} className="flex cursor-pointer items-center gap-2 text-xs">
                        <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} className="accent-neutral-900 dark:accent-white" />
                        <span className="text-[var(--text)] ">{label}</span>
                      </label>
                    ))}
                  </div>
                  {usedSlots.length > 0 && (
                    <>
                      <p className="mt-3 mb-1.5 text-xs font-medium text-[var(--text-muted)] ">Калібрувати філамент у слоті</p>
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
                              <span className="truncate text-[var(--text)] ">Слот {i + 1}{fileType ? ` · ${fileType}` : ""}</span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* result banner */}
          {result && (
            <div className={["rounded-lg px-3 py-2 text-sm",
              result.ok
                ? "border border-[rgba(34,197,94,.25)] bg-[rgba(34,197,94,.08)] text-[var(--state-ok)]"
                : "border border-[rgba(239,68,68,.25)] bg-[rgba(239,68,68,.08)] text-[var(--state-error)]",
            ].join(" ")}>
              {result.ok ? "✓ " : "✕ "}{result.message}
              {queuedJob && queuedJob.printer_id != null && (
                <Link href={`/printers/${queuedJob.printer_id}`} onClick={onClose}
                  className="mt-1 block text-sm font-medium underline hover:no-underline">
                  Переглянути завдання →
                </Link>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3 ">
          <button onClick={onClose} className="btn btn-ghost">
            {result?.ok ? "Закрити" : "Скасувати"}
          </button>
          {!result?.ok && mode === "print" && (
            <button onClick={sendPrint} disabled={!selectedId || busy}
              className="btn btn-primary disabled:opacity-40">
              {busy ? "Надсилаю…" : "Надіслати"}
            </button>
          )}
          {!result?.ok && mode === "save" && (
            <button onClick={onClose} className="btn btn-primary">
              Готово
            </button>
          )}
          {!result?.ok && mode === "queue" && (
            <button onClick={addToQueue} disabled={busy}
              className="btn btn-primary disabled:opacity-40">
              {busy ? "Додаю…" : "Додати в чергу"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
