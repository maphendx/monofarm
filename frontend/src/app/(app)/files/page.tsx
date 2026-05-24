"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ApiError, api, getToken } from "@/lib/api";
import { useUser } from "@/lib/auth-context";
import type { GcodeFile, GcodeFileMeta, GcodeFolder, Printer } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// XHR-based upload so we can show real upload progress (fetch doesn't expose it).
function uploadWithProgress<T>(
  path: string,
  body: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
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
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError(xhr.status, "Bad JSON response"));
        }
        return;
      }
      let detail = xhr.statusText;
      try {
        const data = JSON.parse(xhr.responseText);
        detail = data.detail ?? detail;
      } catch {
        /* ignore */
      }
      reject(new ApiError(xhr.status, detail));
    };
    xhr.onerror = () => reject(new ApiError(0, "Помилка мережі"));
    xhr.send(body);
  });
}

// A file slot is "used" if used_g[i] > 0. When used_g is missing, assume
// every configured slot is used (older slicer outputs without weight data).
function usedSlotIndices(meta: GcodeFileMeta | null): number[] {
  if (!meta) return [];
  const total = Math.max(meta.colors?.length ?? 0, meta.types?.length ?? 0);
  if (total === 0) return [];
  const usedG = meta.used_g;
  if (!usedG || usedG.length === 0) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    const g = usedG[i];
    if (g === undefined || g > 0) out.push(i);
  }
  return out;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "3mf") return "📦";
  return "📄";
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m} хв`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min > 0 ? `${h} г ${min} хв` : `${h} г`;
}

// ── Filament slot swatches ────────────────────────────────────────────────────

function SlotSwatches({ meta }: { meta: GcodeFileMeta }) {
  const colors = meta.colors ?? [];
  const types = meta.types ?? [];
  const indices = usedSlotIndices(meta);
  if (indices.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {indices.map((i) => {
        const color = colors[i] ?? null;
        const type = types[i] ?? null;
        const grams = meta.used_g?.[i];
        const label = [type, grams != null ? `${grams}г` : null].filter(Boolean).join(" · ");
        return (
          <div
            key={i}
            title={`Слот ${i + 1}: ${label || "—"}`}
            className="flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          >
            {color && (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                style={{ background: color }}
              />
            )}
            <span>{`Слот ${i + 1}`}{type ? ` · ${type}` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Slot compatibility checker ────────────────────────────────────────────────

type SlotMatch = "ok" | "type_mismatch" | "missing";

function checkSlots(
  meta: GcodeFileMeta | null,
  printer: Printer
): { slot: number; fileColor: string | null; fileType: string | null; match: SlotMatch; printerColor: string | null; printerType: string | null }[] {
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

function compatBadge(slots: ReturnType<typeof checkSlots>): { label: string; cls: string } {
  if (slots.length === 0) return { label: "немає даних", cls: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800" };
  const missing = slots.filter((s) => s.match === "missing").length;
  const mismatch = slots.filter((s) => s.match === "type_mismatch").length;
  if (missing === 0 && mismatch === 0) return { label: "сумісний ✓", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" };
  if (missing > 0) return { label: `${missing} слот${missing > 1 ? "и" : ""} відсутні`, cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" };
  return { label: `тип не збігається (${mismatch})`, cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
}

// ── Send-to-printer modal ─────────────────────────────────────────────────────

function SendModal({
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
  // slotMap: key = file slot index (0-based), value = printer slot (0-based)
  const [slotMap, setSlotMap] = useState<Record<number, number>>({});

  // U1 print options (Moonraker only). Defaults mirror Snaporca's emitted
  // gcode — bed mesh + timelapse + AI detection + all-slot flow calibration
  // are all on, so keeping defaults leaves the file byte-identical to what
  // the slicer wrote.
  const [autoBedLeveling, setAutoBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(true);
  const [aiDetection, setAiDetection] = useState(true);
  // Set of file-slot indices (0-based) to calibrate via SM_PRINT_FLOW_CALIBRATE
  const [calibrateSlots, setCalibrateSlots] = useState<Set<number>>(new Set());

  const sendablePrinters = printers.filter(
    (p) => p.is_active && (p.moonraker_url || (p.kind === "bambu" && p.bambu_dev_id)),
  );
  const selectedPrinter = sendablePrinters.find((p) => p.id === selectedId) ?? null;

  const usedSlots = useMemo(() => usedSlotIndices(file.filament_meta), [file.filament_meta]);
  const isMoonraker = !!selectedPrinter?.moonraker_url;

  // When printer changes, reset slot map to identity for used slots only
  function selectPrinter(id: number) {
    setSelectedId(id);
    setResult(null);
    const identity: Record<number, number> = {};
    for (const i of usedSlots) identity[i] = i;
    setSlotMap(identity);
    // Default: calibrate every used slot (matches slicer's default output)
    setCalibrateSlots(new Set(usedSlots));
  }

  function toggleCalibrate(slot: number) {
    setCalibrateSlots((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }

  async function send() {
    if (!selectedId) return;
    setBusy(true);
    setResult(null);
    try {
      const apiSlotMap: Record<number, number> = {};
      for (const i of usedSlots) {
        apiSlotMap[i] = slotMap[i] ?? i;
      }
      const body: Record<string, unknown> = { slot_map: apiSlotMap };
      if (isMoonraker) {
        // Only send disables — the backend leaves slicer output alone otherwise.
        if (!autoBedLeveling) body.auto_bed_leveling = false;
        if (!timelapse) body.timelapse = false;
        if (!aiDetection) body.ai_detection = false;
        if (calibrateSlots.size !== usedSlots.length) {
          body.calibrate_slots = Array.from(calibrateSlots).sort((a, b) => a - b);
        }
      }
      const res = await api<{ ok: boolean; printer_name: string; message: string }>(
        `/api/files/${file.id}/send/${selectedId}`,
        { method: "POST", body: JSON.stringify(body) }
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

        {/* file slot summary */}
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
            <p className="text-sm text-neutral-500">
              Немає доступних принтерів для надсилання
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 max-h-80 overflow-y-auto pr-1">
              {sendablePrinters.map((p) => {
                const slots = checkSlots(file.filament_meta, p);
                const compat = compatBadge(slots);
                return (
                  <label
                    key={p.id}
                    className={[
                      "flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition",
                      selectedId === p.id
                        ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-800"
                        : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500",
                    ].join(" ")}
                  >
                    {/* top row */}
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="printer"
                        value={p.id}
                        checked={selectedId === p.id}
                        onChange={() => selectPrinter(p.id)}
                        className="accent-neutral-900 dark:accent-white"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                      </div>
                      <span
                        className={[
                          "shrink-0 rounded px-1.5 py-0.5 text-xs",
                          p.state === "printing"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                            : p.state === "idle" || p.state === "operational"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800",
                        ].join(" ")}
                      >
                        {p.state ?? "—"}
                      </span>
                    </div>

                    {/* slot-by-slot compatibility */}
                    {slots.length > 0 && (
                      <div className="ml-6 flex flex-wrap gap-1">
                        {slots.map((s) => (
                          <div
                            key={s.slot}
                            title={
                              s.match === "ok"
                                ? `Слот ${s.slot}: ${s.printerType ?? "?"} завантажено`
                                : s.match === "type_mismatch"
                                ? `Слот ${s.slot}: потрібно ${s.fileType}, завантажено ${s.printerType}`
                                : `Слот ${s.slot}: нічого не завантажено`
                            }
                            className={[
                              "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
                              s.match === "ok"
                                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                                : s.match === "type_mismatch"
                                ? "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                                : "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400",
                            ].join(" ")}
                          >
                            {s.fileColor && (
                              <span
                                className="h-2 w-2 shrink-0 rounded-full border border-black/10"
                                style={{ background: s.fileColor }}
                              />
                            )}
                            {s.match === "ok" ? "✓" : s.match === "type_mismatch" ? "~" : "✕"}
                            {" "}Слот {s.slot}
                            {s.match === "type_mismatch" && s.printerType && ` (є ${s.printerType})`}
                          </div>
                        ))}
                        <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${compat.cls}`}>
                          {compat.label}
                        </span>
                      </div>
                    )}

                    {/* printer loaded filaments if no file meta */}
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

          {/* ── Slot remapping (only for slots actually used in this print) ── */}
          {selectedPrinter && usedSlots.length > 0 && !result && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Ремаппінг слотів
              </p>
              <div className="space-y-2">
                {usedSlots.map((i) => {
                  const fileColor = file.filament_meta?.colors?.[i] ?? null;
                  const fileType = file.filament_meta?.types?.[i] ?? null;
                  const currentPrinterSlot = slotMap[i] ?? i;

                  return (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {/* file slot */}
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {fileColor && (
                          <span
                            className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                            style={{ background: fileColor }}
                          />
                        )}
                        <span className="truncate text-neutral-700 dark:text-neutral-300">
                          Слот {i + 1} {fileType ? `· ${fileType}` : ""}
                        </span>
                      </div>

                      <span className="text-neutral-400">→</span>

                      {/* printer slot selector */}
                      <select
                        value={currentPrinterSlot}
                        onChange={(e) =>
                          setSlotMap((prev) => ({ ...prev, [i]: Number(e.target.value) }))
                        }
                        className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900"
                      >
                        {selectedPrinter.loaded_filaments.length > 0
                          ? selectedPrinter.loaded_filaments.map((lf) => (
                              <option key={lf.slot} value={lf.slot}>
                                Слот {lf.slot + 1}
                                {lf.type ? ` · ${lf.type}` : ""}
                                {lf.color_name ? ` · ${lf.color_name}` : ""}
                              </option>
                            ))
                          : Array.from({ length: 4 }).map((_, s) => (
                              <option key={s} value={s}>
                                Слот {s + 1}
                              </option>
                            ))}
                      </select>

                      {/* color swatch of selected printer slot */}
                      {(() => {
                        const lf = selectedPrinter.loaded_filaments.find(
                          (f) => f.slot === currentPrinterSlot
                        );
                        return lf?.color ? (
                          <span
                            className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                            style={{ background: lf.color }}
                            title={lf.color_name ?? lf.color}
                          />
                        ) : null;
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Snapmaker U1 print options ── */}
          {selectedPrinter && isMoonraker && !result && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Опції друку
              </p>
              <div className="space-y-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={autoBedLeveling}
                    onChange={(e) => setAutoBedLeveling(e.target.checked)}
                    className="accent-neutral-900 dark:accent-white"
                  />
                  <span className="text-neutral-700 dark:text-neutral-300">Автокалібрування столу</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={timelapse}
                    onChange={(e) => setTimelapse(e.target.checked)}
                    className="accent-neutral-900 dark:accent-white"
                  />
                  <span className="text-neutral-700 dark:text-neutral-300">Таймлапс</span>
                </label>
                <label
                  className="flex cursor-pointer items-center gap-2 text-xs"
                  title="Камерна перевірка чистоти столу, типу пластини та дефектів під час друку"
                >
                  <input
                    type="checkbox"
                    checked={aiDetection}
                    onChange={(e) => setAiDetection(e.target.checked)}
                    className="accent-neutral-900 dark:accent-white"
                  />
                  <span className="text-neutral-700 dark:text-neutral-300">AI детекція</span>
                </label>
              </div>

              {usedSlots.length > 0 && (
                <>
                  <p className="mt-3 mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                    Калібрувати філамент у слоті
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {usedSlots.map((i) => {
                      const fileColor = file.filament_meta?.colors?.[i] ?? null;
                      const fileType = file.filament_meta?.types?.[i] ?? null;
                      return (
                        <label
                          key={i}
                          className="flex cursor-pointer items-center gap-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={calibrateSlots.has(i)}
                            onChange={() => toggleCalibrate(i)}
                            className="accent-neutral-900 dark:accent-white"
                          />
                          {fileColor && (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                              style={{ background: fileColor }}
                            />
                          )}
                          <span className="truncate text-neutral-700 dark:text-neutral-300">
                            Слот {i + 1}
                            {fileType ? ` · ${fileType}` : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {result && (
            <div
              className={[
                "rounded-lg px-3 py-2 text-sm",
                result.ok
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400",
              ].join(" ")}
            >
              {result.ok ? "✓ " : "✕ "}
              {result.message}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {result?.ok ? "Закрити" : "Скасувати"}
          </button>
          {!result?.ok && (
            <button
              onClick={send}
              disabled={!selectedId || busy}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? "Надсилаю…" : "Надіслати"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Download button (fetch with auth header → blob URL) ───────────────────────

function DownloadLink({ fileId, fileName }: { fileId: number; fileName: string }) {
  const [busy, setBusy] = useState(false);
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const token = getToken();
      const resp = await fetch(`${API_URL}/api/files/${fileId}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={download}
      disabled={busy}
      className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
      title="Завантажити"
    >
      {busy ? "…" : "↓"}
    </button>
  );
}

// Two-step delete button. Skips the native confirm() because Chrome lets users
// permanently suppress it — after that, the button silently does nothing.
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (confirming) {
    return (
      <button
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
        className="animate-pulse rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700"
        title="Натисніть ще раз щоб видалити"
      >
        ✕ Підтвердити
      </button>
    );
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-500 transition hover:bg-red-50 hover:text-red-600 dark:border-neutral-700 dark:hover:bg-red-900/20 dark:hover:text-red-400"
      title="Видалити"
    >
      ✕
    </button>
  );
}

// ── Move-to-folder popup ──────────────────────────────────────────────────────

function MovePopup({
  file,
  folders,
  onMove,
  onClose,
}: {
  file: GcodeFile;
  folders: GcodeFolder[];
  onMove: (folderId: number | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xs rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold text-sm">Перемістити до папки</h2>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{file.original_name}</p>
        </div>
        <div className="max-h-64 overflow-y-auto px-3 py-3 space-y-1">
          <button
            onClick={() => onMove(null)}
            className={[
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800",
              file.folder_id === null ? "font-medium text-neutral-900 dark:text-neutral-100" : "text-neutral-600 dark:text-neutral-400",
            ].join(" ")}
          >
            <span className="text-base">🏠</span> Без папки
            {file.folder_id === null && <span className="ml-auto text-xs text-neutral-400">поточна</span>}
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              onClick={() => onMove(f.id)}
              className={[
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800",
                file.folder_id === f.id ? "font-medium text-neutral-900 dark:text-neutral-100" : "text-neutral-600 dark:text-neutral-400",
              ].join(" ")}
            >
              <span className="text-base">📁</span>
              <span className="truncate">{f.name}</span>
              {file.folder_id === f.id && <span className="ml-auto text-xs text-neutral-400">поточна</span>}
            </button>
          ))}
        </div>
        <div className="flex justify-end border-t border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Скасувати
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create/Rename folder modal ────────────────────────────────────────────────

function FolderNameModal({
  title,
  initialValue,
  onConfirm,
  onClose,
}: {
  title: string;
  initialValue?: string;
  onConfirm: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xs rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="font-semibold text-sm">{title}</h2>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Назва папки"
            maxLength={255}
            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-neutral-400"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Скасувати
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? "…" : "Зберегти"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Folder chip (sidebar item) ────────────────────────────────────────────────

function FolderChip({
  folder,
  active,
  canEdit,
  onClick,
  onRename,
  onDelete,
}: {
  folder: GcodeFolder;
  active: boolean;
  canEdit: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  return (
    <div
      className={[
        "group flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition select-none",
        active
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="text-base leading-none shrink-0">📁</span>
      <span className="truncate flex-1 min-w-0">{folder.name}</span>
      <span
        className={[
          "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
          active
            ? "bg-white/20 text-white dark:bg-black/20 dark:text-neutral-900"
            : "bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400",
        ].join(" ")}
      >
        {folder.file_count}
      </span>
      {canEdit && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onRename}
            className={[
              "rounded p-0.5 text-xs transition",
              active ? "hover:bg-white/20 text-white" : "hover:bg-neutral-200 text-neutral-400 dark:hover:bg-neutral-700",
            ].join(" ")}
            title="Перейменувати"
          >
            ✏️
          </button>
          {confirmDelete ? (
            <button
              onClick={onDelete}
              className="animate-pulse rounded p-0.5 text-xs text-red-500 hover:text-red-600"
              title="Підтвердити видалення"
            >
              ✕
            </button>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className={[
                "rounded p-0.5 text-xs transition",
                active ? "hover:bg-white/20 text-white/70" : "hover:bg-neutral-200 text-neutral-400 dark:hover:bg-neutral-700",
              ].join(" ")}
              title="Видалити папку"
            >
              🗑️
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── File card ─────────────────────────────────────────────────────────────────

function FileCard({
  file,
  canEdit,
  highlighted = false,
  folders,
  onSend,
  onDelete,
  onMove,
}: {
  file: GcodeFile;
  canEdit: boolean;
  highlighted?: boolean;
  folders: GcodeFolder[];
  onSend: () => void;
  onDelete: () => void;
  onMove: (folderId: number | null) => void;
}) {
  const [showMovePopup, setShowMovePopup] = useState(false);

  return (
    <>
      <div
        className={[
          "group relative flex flex-col gap-3 rounded-xl border p-4 shadow-sm transition",
          highlighted
            ? "border-neutral-900 bg-neutral-50 ring-2 ring-neutral-900/20 dark:border-neutral-100 dark:bg-neutral-800 dark:ring-neutral-100/20"
            : "border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600",
        ].join(" ")}
      >
        {/* icon + name */}
        <div className="flex items-start gap-3">
          {file.has_thumbnail ? (
            <img
              src={`${API_URL}/api/files/${file.id}/thumbnail`}
              alt=""
              className="h-12 w-12 shrink-0 rounded-lg object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
                (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty("display", "");
              }}
            />
          ) : null}
          <span
            className="mt-0.5 text-2xl leading-none"
            style={{ display: file.has_thumbnail ? "none" : "" }}
          >
            {extIcon(file.original_name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight" title={file.original_name}>
              {file.original_name}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">{fmtSize(file.size_bytes)}</p>
          </div>
        </div>

        {/* filament swatches */}
        {file.filament_meta && <SlotSwatches meta={file.filament_meta} />}

        {/* meta */}
        <div className="space-y-0.5 text-xs text-neutral-400">
          <p>{fmtDate(file.uploaded_at)}</p>
          {file.filament_meta?.estimated_minutes && (
            <p>~{fmtMinutes(file.filament_meta.estimated_minutes)}</p>
          )}
          {file.uploaded_by_name && <p>{file.uploaded_by_name}</p>}
          {file.notes && (
            <p className="line-clamp-2 text-neutral-500 dark:text-neutral-400">{file.notes}</p>
          )}
        </div>

        {/* actions */}
        <div className="mt-auto flex gap-2">
          <button
            onClick={onSend}
            className="flex-1 rounded-lg border border-neutral-200 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Надіслати →
          </button>
          <DownloadLink fileId={file.id} fileName={file.original_name} />
          {canEdit && (
            <button
              onClick={() => setShowMovePopup(true)}
              className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Перемістити до папки"
            >
              📁
            </button>
          )}
          {canEdit && <DeleteButton onDelete={onDelete} />}
        </div>
      </div>

      {showMovePopup && (
        <MovePopup
          file={file}
          folders={folders}
          onMove={(folderId) => {
            onMove(folderId);
            setShowMovePopup(false);
          }}
          onClose={() => setShowMovePopup(false)}
        />
      )}
    </>
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
  const [activeFolderId, setActiveFolderId] = useState<number | null | "all">("all");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<GcodeFolder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [f, p, fols] = await Promise.all([
        api<GcodeFile[]>("/api/files"),
        api<Printer[]>("/api/printers"),
        api<GcodeFolder[]>("/api/folders"),
      ]);
      setFiles(f);
      setPrinters(p);
      setFolders(fols);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-open send modal for file highlighted via ?highlight= (from OrcaSlicer)
  useEffect(() => {
    if (!highlightId || loading || sendFile) return;
    const file = files.find((f) => f.id === highlightId);
    if (!file) return;
    setSendFile(file);
  }, [highlightId, loading, files]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      // Upload into the currently-active folder (if any)
      const uploadPath =
        activeFolderId !== "all" && activeFolderId !== null
          ? `/api/files/upload?folder_id=${activeFolderId}`
          : "/api/files/upload";
      const saved = await uploadWithProgress<GcodeFile>(
        uploadPath,
        form,
        (pct) => setUploadProgress(pct),
      );
      setFiles((prev) => [saved, ...prev]);
      // Refresh folder counts
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
      setSendFile(saved);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Помилка завантаження");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function handleDelete(file: GcodeFile) {
    try {
      await api(`/api/files/${file.id}`, { method: "DELETE" });
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      // Refresh folder counts
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : "Не вдалося видалити файл");
    }
  }

  async function handleMove(file: GcodeFile, folderId: number | null) {
    try {
      const updated = await api<GcodeFile>(`/api/files/${file.id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ folder_id: folderId }),
      });
      setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      // Refresh folder counts
      const updatedFolders = await api<GcodeFolder[]>("/api/folders");
      setFolders(updatedFolders);
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : "Не вдалося перемістити файл");
    }
  }

  async function handleCreateFolder(name: string) {
    const folder = await api<GcodeFolder>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)));
    setShowNewFolder(false);
    setActiveFolderId(folder.id);
  }

  async function handleRenameFolder(folder: GcodeFolder, name: string) {
    const updated = await api<GcodeFolder>(`/api/folders/${folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setFolders((prev) =>
      prev.map((f) => (f.id === updated.id ? updated : f)).sort((a, b) => a.name.localeCompare(b.name))
    );
    setRenamingFolder(null);
  }

  async function handleDeleteFolder(folder: GcodeFolder) {
    try {
      await api(`/api/folders/${folder.id}`, { method: "DELETE" });
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      // Files move to root — reset folder_id in local state
      setFiles((prev) =>
        prev.map((f) => (f.folder_id === folder.id ? { ...f, folder_id: null } : f))
      );
      if (activeFolderId === folder.id) setActiveFolderId("all");
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : "Не вдалося видалити папку");
    }
  }

  // Filter files by active folder + search
  const filtered = files.filter((f) => {
    const matchesFolder =
      activeFolderId === "all" ||
      (activeFolderId === null ? f.folder_id === null : f.folder_id === activeFolderId);
    const matchesSearch = f.original_name.toLowerCase().includes(search.toLowerCase());
    return matchesFolder && matchesSearch;
  });

  const activeFolder = activeFolderId !== "all" && activeFolderId !== null
    ? folders.find((f) => f.id === activeFolderId) ?? null
    : null;

  if (loading) return <div className="text-sm text-neutral-500">Завантаження…</div>;

  const targetPrinter = defaultPrinterId ? printers.find(p => p.id === defaultPrinterId) : null;

  return (
    <>
      {/* pre-selected printer banner */}
      {targetPrinter && !sendFile && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900/40 dark:bg-blue-900/20">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-600 dark:text-blue-400">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <p className="text-sm text-blue-800 dark:text-blue-300">
            Вибери файл для відправки на <strong>{targetPrinter.name}</strong>
          </p>
        </div>
      )}

      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Файли</h1>
          <p className="text-sm text-neutral-500">
            {files.length} {files.length === 1 ? "файл" : files.length < 5 ? "файли" : "файлів"} · центральне сховище нарізок
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {uploadError && (
              <span className="text-xs text-red-600 dark:text-red-400">{uploadError}</span>
            )}
            <button
              onClick={() => setShowNewFolder(true)}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <span>📁</span> Нова папка
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="relative flex min-w-44 items-center justify-center gap-2 overflow-hidden rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-default disabled:hover:bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:hover:bg-neutral-100"
            >
              {uploading && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-150 dark:bg-black/25"
                  style={{ width: `${uploadProgress}%` }}
                />
              )}
              <span className="relative flex items-center gap-2">
                {uploading ? (
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <span className="text-base leading-none">↑</span>
                )}
                {uploading ? `Завантаження ${uploadProgress}%` : "Завантажити файл"}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gcode,.gco,.g,.3mf,.bgcode"
              className="hidden"
              onChange={handleUpload}
            />
          </div>
        )}
      </div>

      {/* folder strip + content */}
      <div className="mt-4 flex gap-6">
        {/* ── Folder sidebar ── */}
        <div className="w-48 shrink-0 space-y-0.5">
          {/* All files */}
          <div
            className={[
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition select-none",
              activeFolderId === "all"
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
            ].join(" ")}
            onClick={() => setActiveFolderId("all")}
          >
            <span className="text-base leading-none shrink-0">🗂️</span>
            <span className="truncate flex-1">Всі файли</span>
            <span
              className={[
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                activeFolderId === "all"
                  ? "bg-white/20 text-white dark:bg-black/20 dark:text-neutral-900"
                  : "bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400",
              ].join(" ")}
            >
              {files.length}
            </span>
          </div>

          {/* Root (no folder) — only show if there are unorganised files */}
          {files.some((f) => f.folder_id === null) && (
            <div
              className={[
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition select-none",
                activeFolderId === null
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
              ].join(" ")}
              onClick={() => setActiveFolderId(null)}
            >
              <span className="text-base leading-none shrink-0">🏠</span>
              <span className="truncate flex-1">Без папки</span>
              <span
                className={[
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  activeFolderId === null
                    ? "bg-white/20 text-white dark:bg-black/20 dark:text-neutral-900"
                    : "bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400",
                ].join(" ")}
              >
                {files.filter((f) => f.folder_id === null).length}
              </span>
            </div>
          )}

          {folders.length > 0 && (
            <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
          )}

          {folders.map((folder) => (
            <FolderChip
              key={folder.id}
              folder={folder}
              active={activeFolderId === folder.id}
              canEdit={canEdit}
              onClick={() => setActiveFolderId(folder.id)}
              onRename={() => setRenamingFolder(folder)}
              onDelete={() => handleDeleteFolder(folder)}
            />
          ))}
        </div>

        {/* ── Main area ── */}
        <div className="min-w-0 flex-1">
          {/* breadcrumb */}
          <div className="mb-3 flex items-center gap-1.5 text-xs text-neutral-500">
            <span
              className="cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-300"
              onClick={() => setActiveFolderId("all")}
            >
              Файли
            </span>
            {activeFolder && (
              <>
                <span>/</span>
                <span className="font-medium text-neutral-700 dark:text-neutral-300">{activeFolder.name}</span>
              </>
            )}
            {activeFolderId === null && (
              <>
                <span>/</span>
                <span className="font-medium text-neutral-700 dark:text-neutral-300">Без папки</span>
              </>
            )}
          </div>

          {/* search */}
          {files.length > 0 && (
            <div className="relative mb-4 max-w-sm">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400">
                🔍
              </span>
              <input
                type="text"
                placeholder="Пошук файлів…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-400"
              />
            </div>
          )}

          {/* grid */}
          {filtered.length === 0 ? (
            <div className="mt-16 flex flex-col items-center gap-3 text-neutral-400">
              <span className="text-5xl">📂</span>
              <p className="text-sm">
                {search ? "Нічого не знайдено" : activeFolderId !== "all"
                  ? "У цій папці немає файлів"
                  : "Файлів ще немає — завантажте першу нарізку"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filtered.map((f) => (
                <FileCard
                  key={f.id}
                  file={f}
                  canEdit={canEdit}
                  highlighted={f.id === highlightId}
                  folders={folders}
                  onSend={() => setSendFile(f)}
                  onDelete={() => handleDelete(f)}
                  onMove={(folderId) => handleMove(f, folderId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* send modal */}
      {sendFile && (
        <SendModal
          file={sendFile}
          printers={printers}
          onClose={() => setSendFile(null)}
          defaultPrinterId={defaultPrinterId ?? undefined}
        />
      )}

      {/* create folder modal */}
      {showNewFolder && (
        <FolderNameModal
          title="Нова папка"
          onConfirm={handleCreateFolder}
          onClose={() => setShowNewFolder(false)}
        />
      )}

      {/* rename folder modal */}
      {renamingFolder && (
        <FolderNameModal
          title="Перейменувати папку"
          initialValue={renamingFolder.name}
          onConfirm={(name) => handleRenameFolder(renamingFolder, name)}
          onClose={() => setRenamingFolder(null)}
        />
      )}
    </>
  );
}
