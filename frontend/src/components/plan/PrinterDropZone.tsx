"use client";

import { useDroppable } from "@dnd-kit/core";
import { useRef, useState } from "react";

import { FilamentSwatches } from "@/components/FilamentSwatches";
import { ApiError, api } from "@/lib/api";
import { kindLabel, stateEmoji, stateLabel } from "@/lib/printerLabels";
import type { PlanEntry, Printer } from "@/lib/types";

function PlanEntryRow({
  entry,
  printer,
  onToggleDone,
  onRemove,
}: {
  entry: PlanEntry;
  printer: Printer;
  onToggleDone: () => void;
  onRemove: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const inFlight = useRef(false);

  let cantSendReason: string | null = null;
  let cantSendShort: string | null = null;
  if (entry.done) {
    cantSendReason = "Задача вже виконана";
    cantSendShort = "вже виконано";
  } else if (!entry.task.file_name) {
    cantSendReason = "Немає файлу — додай .gcode/.3mf у задачу";
    cantSendShort = "немає файлу";
  } else if (!printer.moonraker_url) {
    cantSendReason = "У принтера не вказано Moonraker URL";
    cantSendShort = "немає URL принтера";
  }

  const canSend = cantSendReason === null;

  async function send() {
    if (inFlight.current) return; // sync guard against double-click
    inFlight.current = true;
    setSending(true);
    setSendErr(null);
    try {
      await api(`/api/plan/${entry.id}/send`, { method: "POST" });
    } catch (err) {
      setSendErr(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setSending(false);
      inFlight.current = false;
    }
  }

  return (
    <div
      className={
        "rounded-md px-2 py-2 text-sm " +
        (entry.done ? "opacity-50" : "bg-neutral-50 dark:bg-neutral-800/50")
      }
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={entry.done}
          onChange={onToggleDone}
          className="mt-0.5 shrink-0 cursor-pointer accent-emerald-600"
        />
        <div className="min-w-0 flex-1">
          <div className={entry.done ? "line-through" : ""}>
            {entry.task.title}
            {entry.task.quantity > 1 && (
              <span className="ml-1 text-xs text-neutral-400">×{entry.task.quantity}</span>
            )}
            {entry.task.file_name && (
              <span className="ml-1 text-xs text-blue-500" title={entry.task.file_name}>📎</span>
            )}
          </div>
          {entry.task.filament_meta && (
            <div className="mt-1">
              <FilamentSwatches meta={entry.task.filament_meta} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-neutral-300 hover:text-red-500 dark:text-neutral-600"
          aria-label="Прибрати"
        >
          ✕
        </button>
      </div>

      {/* Big, full-width action button — primary call-to-action */}
      <button
        type="button"
        onClick={canSend ? send : undefined}
        disabled={!canSend || sending}
        className={
          "mt-2 block w-full rounded-md py-1.5 text-xs font-medium transition " +
          (canSend
            ? "bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
            : "cursor-not-allowed bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500")
        }
        title={canSend ? "Завантажити файл і запустити друк" : (cantSendReason ?? "")}
      >
        {sending
          ? "Завантажую…"
          : canSend
            ? "▶ Друк"
            : `▶ ${cantSendShort}`}
      </button>

      {sendErr && (
        <div className="mt-1 text-xs text-red-600 dark:text-red-400">{sendErr}</div>
      )}
    </div>
  );
}

export function PrinterDropZone({
  printer,
  entries,
  planDate,
  onEntryAdded,
  onEntryUpdated,
  onEntryRemoved,
}: {
  printer: Printer;
  entries: PlanEntry[];
  planDate: string;
  onEntryAdded: (e: PlanEntry) => void;
  onEntryUpdated: (e: PlanEntry) => void;
  onEntryRemoved: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `printer-${printer.id}`,
    data: { printerId: printer.id },
  });

  async function toggleDone(entry: PlanEntry) {
    try {
      const updated = await api<PlanEntry>(`/api/plan/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ done: !entry.done }),
      });
      onEntryUpdated(updated);
    } catch (err) {
      if (err instanceof ApiError) console.error(err.message);
    }
  }

  async function removeEntry(entry: PlanEntry) {
    try {
      await api(`/api/plan/${entry.id}`, { method: "DELETE" });
      onEntryRemoved(entry.id);
    } catch (err) {
      if (err instanceof ApiError) console.error(err.message);
    }
  }

  const doneCount = entries.filter((e) => e.done).length;

  return (
    <div
      ref={setNodeRef}
      className={
        "flex min-h-[120px] flex-col rounded-xl border-2 p-3 transition " +
        (isOver
          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/20"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900")
      }
    >
      <div className="mb-2 flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{printer.name}</div>
          <div className="text-xs text-neutral-500">
            {stateEmoji(printer.state)} {stateLabel(printer.state)} ·{" "}
            {kindLabel(printer.kind)}
          </div>
        </div>
        {entries.length > 0 && (
          <span className="shrink-0 text-xs text-neutral-400">
            {doneCount}/{entries.length}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-1">
        {entries.map((entry) => (
          <PlanEntryRow
            key={entry.id}
            entry={entry}
            printer={printer}
            onToggleDone={() => toggleDone(entry)}
            onRemove={() => removeEntry(entry)}
          />
        ))}
      </div>

      {isOver && entries.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-emerald-600 dark:text-emerald-400">
          Відпустити тут
        </div>
      )}

      {!isOver && entries.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-neutral-300 dark:text-neutral-700">
          Перетягни задачу
        </div>
      )}
    </div>
  );
}
