"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { Filament, PrinterKind, PrinterSlotInfo } from "@/lib/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function groupByUnit(slots: PrinterSlotInfo[]): PrinterSlotInfo[][] {
  const external = slots.filter((s) => s.is_external);
  const normal = slots.filter((s) => !s.is_external);
  const units = new Map<number, PrinterSlotInfo[]>();
  for (const s of normal) {
    const u = s.unit_index ?? 0;
    if (!units.has(u)) units.set(u, []);
    units.get(u)!.push(s);
  }
  const groups: PrinterSlotInfo[][] = [];
  for (const u of [...units.keys()].sort()) {
    groups.push(units.get(u)!.sort((a, b) => a.slot_index - b.slot_index));
  }
  if (external.length) groups.push(external);
  return groups;
}

function slotLabel(slot: PrinterSlotInfo, kind: PrinterKind): string {
  if (slot.is_external) return "External";
  if (kind === "bambu") {
    const unit = slot.unit_index ?? 0;
    return `AMS${unit + 1}-T${slot.slot_index - unit * 4 + 1}`;
  }
  return `T${slot.slot_index + 1}`;
}

// ── SlotPicker popup ──────────────────────────────────────────────────────────

function SlotPicker({
  slot,
  label,
  filaments,
  printerId,
  anchorRect,
  onClose,
  onSaved,
}: {
  slot: PrinterSlotInfo;
  label: string;
  filaments: Filament[];
  printerId: number;
  anchorRect: DOMRect;
  onClose: () => void;
  onSaved: (updated: PrinterSlotInfo) => void;
}) {
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = search.toLowerCase();
  const filtered = filaments.filter(
    (f) =>
      !q ||
      f.material.toLowerCase().includes(q) ||
      f.color.toLowerCase().includes(q) ||
      (f.brand ?? "").toLowerCase().includes(q),
  );

  async function pick(filamentId: number | null) {
    setSaving(true);
    setError(null);
    try {
      const updated = await api<PrinterSlotInfo>(
        `/api/printers/${printerId}/slots/${slot.slot_index}`,
        { method: "PUT", body: JSON.stringify({ filament_id: filamentId }) },
      );
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Помилка");
      setSaving(false);
    }
  }

  // Position: below the anchor dot, clamped to viewport
  const GAP = 6;
  const PICKER_W = 220;
  const viewW = typeof window !== "undefined" ? window.innerWidth : 9999;
  let left = anchorRect.left + anchorRect.width / 2 - PICKER_W / 2;
  if (left + PICKER_W > viewW - 8) left = viewW - PICKER_W - 8;
  if (left < 8) left = 8;
  const top = anchorRect.bottom + GAP;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Picker panel */}
      <div
        className="fixed z-50 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl"
        style={{ top, left, width: PICKER_W }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--border)] px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{label}</span>
            {slot.filament_id && (
              <button
                type="button"
                onClick={() => pick(null)}
                disabled={saving}
                className="text-[10px] text-[var(--state-error)] hover:underline disabled:opacity-40"
              >
                Вивантажити
              </button>
            )}
          </div>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Шукати…"
            className="mt-1.5 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">
              Філаменти не знайдені
            </p>
          ) : (
            filtered.map((f) => {
              const isLoaded = f.id === slot.filament_id;
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={saving}
                  onClick={() => pick(f.id)}
                  className={[
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition",
                    "hover:bg-[var(--surface-hi)] disabled:opacity-50",
                    isLoaded ? "bg-[var(--surface-hi)]" : "",
                  ].join(" ")}
                >
                  {/* Color swatch */}
                  <span
                    className="size-3 shrink-0 rounded-full ring-1 ring-[var(--border-strong)]"
                    style={{ backgroundColor: f.hex_color ?? "#888" }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{f.material}</span>
                    {" · "}
                    <span className="text-[var(--text-muted)]">
                      {f.color}
                      {f.brand ? ` · ${f.brand}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                    {f.grams_remaining}г
                  </span>
                  {isLoaded && (
                    <span className="shrink-0 text-[var(--state-ok)]">✓</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {error && (
          <p className="border-t border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--state-error)]">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

// ── SlotDot ───────────────────────────────────────────────────────────────────

function SlotDot({
  slot,
  label,
  editable,
  onOpen,
}: {
  slot: PrinterSlotInfo;
  label: string;
  editable: boolean;
  onOpen?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const isEmpty = slot.state === "empty" || !slot.filament_id;
  const isRunout = slot.state === "runout";
  const isError = slot.state === "error";
  const hex = slot.hex_color ?? (slot.color?.startsWith("#") ? slot.color : null);

  const tooltipParts = [
    label,
    isEmpty
      ? "порожній"
      : [
          slot.material,
          slot.brand,
          slot.grams_at_load ? `${slot.grams_at_load}г` : null,
          isRunout ? "RUNOUT" : null,
        ]
          .filter(Boolean)
          .join(" · "),
  ]
    .filter(Boolean)
    .join(": ");

  const dotClass = [
    "relative size-3 shrink-0 rounded-full ring-1 transition",
    isEmpty
      ? "ring-[var(--border)] bg-[var(--bg-elevated)]"
      : isRunout || isError
        ? "ring-[var(--state-error)]"
        : "ring-[var(--border-strong)]",
    editable ? "cursor-pointer hover:scale-125 hover:ring-[var(--accent)]" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (editable) {
    return (
      <button
        type="button"
        title={tooltipParts + (editable ? " (клік — змінити)" : "")}
        onClick={onOpen}
        className={dotClass}
        style={hex && !isEmpty ? { backgroundColor: hex } : undefined}
      >
        {(isRunout || isError) && !isEmpty && (
          <span className="absolute inset-0 rounded-full bg-[var(--state-error)] opacity-70" />
        )}
      </button>
    );
  }

  return (
    <span
      title={tooltipParts}
      className={dotClass}
      style={hex && !isEmpty ? { backgroundColor: hex } : undefined}
    >
      {(isRunout || isError) && !isEmpty && (
        <span className="absolute inset-0 rounded-full bg-[var(--state-error)] opacity-70" />
      )}
    </span>
  );
}

// ── SlotStrip ─────────────────────────────────────────────────────────────────

interface SlotStripProps {
  slots: PrinterSlotInfo[];
  kind: PrinterKind;
  /** Show click-to-edit picker on each slot dot */
  editable?: boolean;
  /** Required when editable=true */
  printerId?: number;
  /** Called after a successful slot assignment/unload */
  onSlotUpdated?: (slot: PrinterSlotInfo) => void;
}

/**
 * Universal slot strip — compact dot row for printer cards and detail views.
 * U1: single group of 4 toolhead dots.
 * Bambu: dots grouped by AMS unit; external spool appended.
 * other: sorted list.
 *
 * When editable=true each dot is clickable: opens a filament picker popup.
 */
export function SlotStrip({
  slots,
  kind,
  editable = false,
  printerId,
  onSlotUpdated,
}: SlotStripProps) {
  const [localSlots, setLocalSlots] = useState<PrinterSlotInfo[]>(slots);
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [filaments, setFilaments] = useState<Filament[] | null>(null);
  const [loadingFilaments, setLoadingFilaments] = useState(false);

  // Keep local slots in sync when parent prop changes (e.g. full printer refresh)
  useEffect(() => {
    setLocalSlots(slots);
  }, [slots]);

  // Fetch filament inventory once on first open
  async function ensureFilaments() {
    if (filaments !== null || loadingFilaments) return;
    setLoadingFilaments(true);
    try {
      const list = await api<Filament[]>("/api/filaments");
      setFilaments(list);
    } catch {
      setFilaments([]);
    } finally {
      setLoadingFilaments(false);
    }
  }

  function openPicker(e: React.MouseEvent<HTMLButtonElement>, slotIndex: number) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    setAnchorRect(rect);
    setOpenSlot(slotIndex);
    ensureFilaments();
  }

  function handleSaved(updated: PrinterSlotInfo) {
    setLocalSlots((prev) =>
      prev.map((s) => (s.slot_index === updated.slot_index ? updated : s)),
    );
    onSlotUpdated?.(updated);
  }

  if (!localSlots.length) return null;

  const groups = kind === "bambu" ? groupByUnit(localSlots) : [localSlots];
  const slotByIndex = Object.fromEntries(localSlots.map((s) => [s.slot_index, s]));
  const openSlotObj = openSlot !== null ? slotByIndex[openSlot] : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {groups.map((group, gi) => (
          <div key={gi} className="flex gap-1">
            {group.map((s) => {
              const label = slotLabel(s, kind);
              return (
                <SlotDot
                  key={s.slot_index}
                  slot={s}
                  label={label}
                  editable={editable && !!printerId}
                  onOpen={
                    editable && printerId
                      ? (e) => openPicker(e, s.slot_index)
                      : undefined
                  }
                />
              );
            })}
          </div>
        ))}

        {editable && loadingFilaments && (
          <span className="text-[10px] text-[var(--text-muted)]">…</span>
        )}
      </div>

      {openSlot !== null && openSlotObj && anchorRect && filaments !== null && printerId && (
        <SlotPicker
          slot={openSlotObj}
          label={slotLabel(openSlotObj, kind)}
          filaments={filaments}
          printerId={printerId}
          anchorRect={anchorRect}
          onClose={() => setOpenSlot(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
