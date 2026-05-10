"use client";

import { useDroppable } from "@dnd-kit/core";
import { useState } from "react";

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

  const canSend =
    !!entry.task.file_name && !!printer.moonraker_url && !entry.done;

  async function send() {
    setSending(true);
    setSendErr(null);
    try {
      await api(`/api/plan/${entry.id}/send`, { method: "POST" });
    } catch (err) {
      setSendErr(err instanceof ApiError ? err.message : "Помилка");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className={
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm " +
        (entry.done ? "opacity-50" : "bg-neutral-50 dark:bg-neutral-800/50")
      }
    >
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
            <span className="ml-1 text-[10px] text-blue-500" title={entry.task.file_name}>📎</span>
          )}
        </div>
        {sendErr && (
          <div className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">{sendErr}</div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {canSend && (
          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-500 disabled:opacity-50"
            title="Завантажити файл і запустити друк через Moonraker"
          >
            {sending ? "…" : "▶ Друк"}
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="text-neutral-300 hover:text-red-500 dark:text-neutral-600"
          aria-label="Прибрати"
        >
          ✕
        </button>
      </div>
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
